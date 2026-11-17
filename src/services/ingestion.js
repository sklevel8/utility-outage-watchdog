import { diffSnapshots, normaliseArea } from '../core/diff.js';
import { formatAlert } from '../core/format.js';

/**
 * Ingestion orchestrator (SRS FR-1, FR-3).
 *
 * Guarantees:
 *  - cached snapshot is only advanced after the alert is safely queued, so a
 *    queue outage cannot silently swallow a change;
 *  - de-duplication happens before enqueueing, and the BullMQ jobId is stable,
 *    so a retried poll cannot double-send;
 *  - first sync only seeds the cache unless ALERT_ON_FIRST_SYNC=true.
 */
export function createIngestionService({
  client,
  cache,
  dedup,
  alertQueue,
  logger = console,
  zones = [],
  alertOnFirstSync = false,
  snapshotTtlSeconds = 604_800,
  now = () => new Date(),
}) {
  if (!client) throw new TypeError('client is required');
  if (!cache) throw new TypeError('cache is required');
  if (!dedup) throw new TypeError('dedup service is required');
  if (!alertQueue) throw new TypeError('alertQueue is required');

  const snapshotKey = (zoneId) => `zone:snapshot:${zoneId}`;

  async function ingestZone(zone) {
    const payload = await client.getArea(zone.id);
    const snapshot = normaliseArea(payload, {
      areaId: zone.id,
      fetchedAt: now().toISOString(),
    });
    if (!snapshot.areaName) snapshot.areaName = zone.name;

    const cachedRaw = await cache.get(snapshotKey(zone.id));
    const previous = cachedRaw ? JSON.parse(cachedRaw) : null;
    const diff = diffSnapshots(previous, snapshot);

    if (!diff.changed) {
      return { zoneId: zone.id, changed: false, changeType: 'unchanged' };
    }

    if (diff.changeType === 'initial' && !alertOnFirstSync) {
      await cache.set(snapshotKey(zone.id), JSON.stringify(snapshot), snapshotTtlSeconds);
      return { zoneId: zone.id, changed: false, changeType: 'seeded' };
    }

    const claim = await dedup.claim(zone.id, diff.eventId);
    if (!claim.won) {
      // Keep the cache current so the next poll compares against reality,
      // but do not message anyone: this exact event was already announced.
      await cache.set(snapshotKey(zone.id), JSON.stringify(snapshot), snapshotTtlSeconds);
      return { zoneId: zone.id, changed: true, changeType: diff.changeType, suppressed: true };
    }

    const message = formatAlert({
      areaName: snapshot.areaName ?? zone.name,
      previousStage: diff.previousStage,
      currentStage: diff.currentStage,
      events: snapshot.events,
      changeType: diff.changeType,
    });

    await alertQueue.add(
      'fanout',
      {
        zoneId: zone.id,
        areaName: snapshot.areaName ?? zone.name,
        message,
        eventId: diff.eventId,
        changeType: diff.changeType,
        previousStage: diff.previousStage,
        currentStage: diff.currentStage,
      },
      {
        jobId: `fanout:${zone.id}:${diff.eventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
      },
    );

    await cache.set(snapshotKey(zone.id), JSON.stringify(snapshot), snapshotTtlSeconds);

    return {
      zoneId: zone.id,
      changed: true,
      changeType: diff.changeType,
      previousStage: diff.previousStage,
      currentStage: diff.currentStage,
      eventId: diff.eventId,
    };
  }

  return {
    async run() {
      const startedAt = Date.now();
      const results = [];

      for (const zone of zones) {
        try {
          results.push(await ingestZone(zone));
        } catch (error) {
          // One bad zone must not stop the others, and must not be retried as
          // a whole batch (each zone costs a credit).
          logger.error?.({ zoneId: zone.id, err: error.message }, 'ingestion failed for zone');
          results.push({ zoneId: zone.id, error: error.message, code: error.code ?? 'UNKNOWN' });
        }
      }

      logger.info?.(
        {
          zones: zones.length,
          alerted: results.filter((r) => r.changed && !r.suppressed && !r.error).length,
          suppressed: results.filter((r) => r.suppressed).length,
          failed: results.filter((r) => r.error).length,
          durationMs: Date.now() - startedAt,
        },
        'ingestion cycle complete',
      );

      return results;
    },
  };
}
