#!/usr/bin/env node
/**
 * Offline end-to-end demo: no Redis, no Postgres, no ESP credits, no Telegram.
 *
 * It exercises the real core modules (diffing, dedup, fan-out, delivery), which
 * is the same code the production workers call.
 */
import {
  createFixtureClient,
  createMemoryCache,
  createMemoryQueue,
  createMemorySubscriberRepo,
  createMemoryTransport,
} from '../src/adapters/memory.js';
import { createDedupService, createMemoryDedupStore } from '../src/core/dedup.js';
import { createDispatcher } from '../src/core/dispatcher.js';
import { TokenBucket } from '../src/core/ratelimit.js';
import { createSubscriberService } from '../src/core/subscribers.js';
import { buildFixtureSequence } from '../src/providers/fixtures.js';
import { createIngestionService } from '../src/services/ingestion.js';

const quiet = { info() {}, warn() {}, error() {} };
const rule = (title) => {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
};

const ZONES = [
  { id: 'city-of-tshwane-tshwane-1', name: 'Tshwane 1' },
  { id: 'eskom-direct-city-of-johannesburg-1', name: 'Johannesburg 1' },
];

const cache = createMemoryCache();
const repo = createMemorySubscriberRepo();
const subscribers = createSubscriberService({ repo });
const queue = createMemoryQueue();
const transport = createMemoryTransport();
const dedup = createDedupService({ store: createMemoryDedupStore() });
const client = createFixtureClient(buildFixtureSequence());

const ingestion = createIngestionService({
  client,
  cache,
  dedup,
  alertQueue: queue,
  logger: quiet,
  zones: ZONES,
  alertOnFirstSync: false,
});

const bucket = new TokenBucket({ capacity: 25, refillPerSecond: 25 });
const dispatcher = createDispatcher({ subscribers, transport, bucket, logger: quiet });

rule('1. Users opt in through the bot (/subscribe)');
for (const userId of ['1001', '1002', '1003']) {
  await subscribers.subscribe({ platform: 'telegram', userId, zoneId: ZONES[0].id });
  console.log(`  subscribed telegram:${userId} -> ${ZONES[0].id}`);
}
await subscribers.subscribe({ platform: 'telegram', userId: '2001', zoneId: ZONES[1].id });
console.log(`  subscribed telegram:2001 -> ${ZONES[1].id}`);

async function processQueue() {
  const pending = queue.jobs.splice(0, queue.jobs.length);
  let delivered = 0;
  const perZone = new Map();

  for (const job of pending) {
    if (job.name !== 'fanout') continue;
    const result = await dispatcher.fanout({
      zoneId: job.data.zoneId,
      message: job.data.message,
      eventId: job.data.eventId,
      enqueue: async (payload) => {
        const outcome = await dispatcher.deliver(payload);
        if (outcome.status === 'sent') {
          delivered += 1;
          perZone.set(job.data.zoneId, (perZone.get(job.data.zoneId) ?? 0) + 1);
        }
      },
    });
    console.log(`  fan-out ${result.zoneId}: ${result.enqueued} recipient(s) queued`);
    console.log(`  message preview: ${job.data.message.split('\n').slice(0, 3).join(' / ')}`);
  }

  for (const [zoneId, count] of perZone) {
    console.log(`  delivered ${count} message(s) for ${zoneId}`);
  }
  console.log(`  total delivered: ${delivered}`);
  return delivered;
}

const cycles = [
  { label: 'first poll (seed only, no alert)', note: 'cache primed' },
  { label: 'Stage 4 -> Stage 6', note: 'alert expected' },
  { label: 'Stage 6 -> Stage 4 (erratic revert)', note: 'new stage, alert expected' },
  { label: 'Stage 4 -> Stage 6 again within 24h', note: 'must be suppressed by dedup' },
];

let cycleNumber = 0;
for (const cycle of cycles) {
  cycleNumber += 1;
  rule(`2.${cycleNumber} Poll cycle ${cycleNumber}: ${cycle.label}`);
  const results = await ingestion.run();
  for (const result of results) {
    const verdict = result.error
      ? `ERROR ${result.error}`
      : result.suppressed
        ? 'SUPPRESSED (already alerted for this event)'
        : result.changed
          ? `ALERT (${result.changeType})`
          : result.changeType === 'seeded'
            ? 'seeded cache'
            : 'no change';
    console.log(`  ${result.zoneId.padEnd(42)} ${verdict}`);
  }
  console.log(`\n  ${cycle.note}`);
  await processQueue();
}

rule('3. Results');
console.log(`  messages sent to users: ${transport.sent.length}`);
console.log(`  cache keys held:        ${cache.size()}`);
const replay = await dedup.claim(ZONES[0].id, 'stage-6');
console.log(`  replay of stage-6 now:  ${replay.won ? 'ALLOWED (unexpected)' : 'BLOCKED for 24h'}`);

rule('4. POPIA erasure: user 1002 sends /stop');
const before = (await repo.listActiveByZone(ZONES[0].id)).length;
const { deleted } = await subscribers.unsubscribe({ platform: 'telegram', userId: '1002' });
const after = (await repo.listActiveByZone(ZONES[0].id)).length;
console.log(`  rows deleted: ${deleted} (zone recipients ${before} -> ${after})`);
console.log(`  row still present? ${(await repo.getByUserId('telegram', '1002')) ? 'YES (BUG)' : 'no'}`);

rule('5. Message actually delivered');
console.log(transport.sent[0]?.text ?? '(nothing sent)');
