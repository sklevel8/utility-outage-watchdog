import { createHash } from 'node:crypto';

/**
 * State-diffing engine (SRS FR-3, SDD §2).
 *
 * Everything in this module is pure: same input -> same snapshot hash -> same
 * diff. That is what makes de-duplication and offline testing possible.
 */

const STAGE_RE = /stage\s*(\d{1,2})/i;

/** Pull "Stage 6" out of free text such as an ESP event note. */
export function extractStage(text) {
  if (text === null || text === undefined) return null;
  const match = String(text).match(STAGE_RE);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : null;
}

/** Stable ordering + normalisation so that re-ordered API arrays are not "changes". */
export function canonicaliseEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event = {}) => ({
      start: event.start ?? null,
      end: event.end ?? null,
      note: String(event.note ?? '').trim(),
      stage: event.stage ?? extractStage(event.note),
      // ESP returns `cancelled` on some events; keeping it means a cancellation
      // is a real diff, which is exactly what we want to alert on.
      cancelled: event.cancelled === true,
    }))
    .sort(
      (a, b) =>
        String(a.start).localeCompare(String(b.start)) ||
        String(a.end).localeCompare(String(b.end)) ||
        a.note.localeCompare(b.note),
    );
}

/**
 * Build the canonical snapshot for one area.
 *
 * `fetchedAt` is deliberately excluded from the hash: two identical schedules
 * fetched 15 minutes apart must hash the same, otherwise every poll "changes".
 */
export function normaliseArea(payload, { areaId = null, fetchedAt = null } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Provider payload must be an object');
  }

  const area = payload.area ?? {};
  const rawEvents = payload.events ?? area.events ?? [];
  const events = canonicaliseEvents(rawEvents);

  const explicitStage =
    payload.stage ?? payload.status?.stage ?? payload.info?.stage ?? null;
  const stageFromEvents = events.find((event) => event.stage !== null)?.stage ?? null;
  const stage =
    explicitStage !== null && explicitStage !== undefined
      ? Number(explicitStage)
      : stageFromEvents;

  const snapshot = {
    areaId: areaId ?? area.id ?? null,
    areaName: String(area.name ?? payload.areaName ?? '').trim() || null,
    region: String(area.region ?? '').trim() || null,
    stage: Number.isFinite(stage) ? stage : null,
    events,
  };

  return {
    ...snapshot,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
    hash: hashSnapshot(snapshot),
  };
}

/** SHA-256 over a canonical JSON projection. Order of keys is fixed by construction. */
export function hashSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot required');
  }
  const projection = JSON.stringify({
    areaId: snapshot.areaId ?? null,
    areaName: snapshot.areaName ?? null,
    stage: snapshot.stage ?? null,
    events: canonicaliseEvents(snapshot.events),
  });
  return createHash('sha256').update(projection).digest('hex');
}

export function stageLabel(stage) {
  if (stage === null || stage === undefined) return 'Unknown';
  if (Number(stage) === 0) return 'No load-shedding';
  return `Stage ${Number(stage)}`;
}

function eventKey(event) {
  return [event.start ?? '', event.end ?? '', event.note ?? '', event.cancelled ? 'c' : 'a'].join('|');
}

/**
 * Compare the cached snapshot with the freshly ingested one.
 *
 * changeType:
 *   initial         - nothing was cached for this zone yet
 *   unchanged       - hashes/diff equal, nothing to do
 *   stage_change    - national stage moved (Stage 4 -> Stage 6)
 *   cleared         - stage dropped to 0 / null, i.e. power restored
 *   schedule_change - same stage, but the event list moved
 */
export function diffSnapshots(previous, next) {
  if (!next) throw new TypeError('next snapshot is required');

  if (!previous) {
    return {
      changed: true,
      changeType: 'initial',
      previousStage: null,
      currentStage: next.stage ?? null,
      addedEvents: [...(next.events ?? [])],
      removedEvents: [],
      // First sync has no "event" to de-duplicate against; hash is fine.
      eventId: next.hash,
    };
  }

  const previousEvents = new Map((previous.events ?? []).map((event) => [eventKey(event), event]));
  const nextEvents = new Map((next.events ?? []).map((event) => [eventKey(event), event]));

  const addedEvents = [...nextEvents].filter(([key]) => !previousEvents.has(key)).map(([, value]) => value);
  const removedEvents = [...previousEvents].filter(([key]) => !nextEvents.has(key)).map(([, value]) => value);

  const previousStage = previous.stage ?? null;
  const currentStage = next.stage ?? null;
  const stageChanged = previousStage !== currentStage;
  const scheduleChanged = addedEvents.length > 0 || removedEvents.length > 0;

  if (!stageChanged && !scheduleChanged) {
    return {
      changed: false,
      changeType: 'unchanged',
      previousStage,
      currentStage,
      addedEvents: [],
      removedEvents: [],
      eventId: null,
    };
  }

  let changeType = 'schedule_change';
  if (stageChanged) {
    changeType = currentStage === null || currentStage === 0 ? 'cleared' : 'stage_change';
  }

  // De-duplicate on the *event identity*, not the payload hash. This is what
  // stops "Stage 4 -> 6 -> 4 -> 6" from messaging users four times in an hour
  // (SRS §3 spam prevention). Schedule churn falls back to the hash.
  const eventId =
    changeType === 'schedule_change' ? next.hash : `stage-${currentStage ?? 'none'}`;

  return {
    changed: true,
    changeType,
    previousStage,
    currentStage,
    addedEvents,
    removedEvents,
    eventId,
  };
}
