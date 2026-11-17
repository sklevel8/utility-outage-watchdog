import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixtureClient,
  createMemoryCache,
  createMemoryQueue,
} from '../src/adapters/memory.js';
import { createDedupService, createMemoryDedupStore } from '../src/core/dedup.js';
import { createIngestionService } from '../src/services/ingestion.js';

const quiet = { info() {}, warn() {}, error() {} };

function setup(sequence) {
  const cache = createMemoryCache();
  const queue = createMemoryQueue();
  const dedup = createDedupService({ store: createMemoryDedupStore() });
  const client = createFixtureClient(sequence);

  const ingestion = createIngestionService({
    client,
    cache,
    dedup,
    alertQueue: queue,
    logger: quiet,
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    alertOnFirstSync: false,
  });

  return { cache, queue, ingestion };
}

test('the first poll only seeds the cache', async () => {
  const { cache, queue, ingestion } = setup({
    'zone-a': [{ area: { id: 'zone-a', name: 'Zone A' }, stage: 4, events: [] }],
  });

  const [result] = await ingestion.run();

  assert.equal(result.changeType, 'seeded');
  assert.equal(queue.jobs.length, 0);
  assert.ok(await cache.get('zone:snapshot:zone-a'));
});

test('a stage escalation enqueues exactly one fan-out with a stable job id', async () => {
  const { queue, ingestion } = setup({
    'zone-a': [
      { area: { id: 'zone-a', name: 'Zone A' }, stage: 4, events: [] },
      { area: { id: 'zone-a', name: 'Zone A' }, stage: 6, events: [] },
    ],
  });

  await ingestion.run();
  const [result] = await ingestion.run();

  assert.equal(result.changeType, 'stage_change');
  assert.equal(result.previousStage, 4);
  assert.equal(result.currentStage, 6);
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].name, 'fanout');
  assert.equal(queue.jobs[0].id, 'fanout:zone-a:stage-6');
  assert.match(queue.jobs[0].data.message, /Stage 4 → Stage 6/);
});

test('the same event within 24h is suppressed but the cache still advances', async () => {
  const stage = (value) => ({ area: { id: 'zone-a', name: 'Zone A' }, stage: value, events: [] });
  const { queue, cache, ingestion } = setup({
    'zone-a': [stage(4), stage(6), stage(4), stage(6)],
  });

  await ingestion.run();
  await ingestion.run();
  await ingestion.run();
  const [fourth] = await ingestion.run();

  assert.equal(fourth.suppressed, true);
  assert.equal(queue.jobs.length, 2, 'only the 6 and the 4 should have been alerted');

  const cached = JSON.parse(await cache.get('zone:snapshot:zone-a'));
  assert.equal(cached.stage, 6, 'cache must reflect reality even when the alert is suppressed');
});

test('a repeated but identical payload produces no alert at all', async () => {
  const payload = { area: { id: 'zone-a', name: 'Zone A' }, stage: 4, events: [] };
  const { queue, ingestion } = setup({ 'zone-a': [payload, structuredClone(payload)] });

  await ingestion.run();
  const [second] = await ingestion.run();

  assert.equal(second.changeType, 'unchanged');
  assert.equal(queue.jobs.length, 0);
});

test('one failing zone does not block the others', async () => {
  const cache = createMemoryCache();
  const queue = createMemoryQueue();
  const dedup = createDedupService({ store: createMemoryDedupStore() });

  const ingestion = createIngestionService({
    client: {
      async getArea(areaId) {
        if (areaId === 'broken') throw new Error('provider 500');
        return { area: { id: areaId, name: 'Good' }, stage: 4, events: [] };
      },
    },
    cache,
    dedup,
    alertQueue: queue,
    logger: quiet,
    zones: [
      { id: 'broken', name: 'Broken' },
      { id: 'good', name: 'Good' },
    ],
  });

  const results = await ingestion.run();

  assert.equal(results.length, 2);
  assert.match(results[0].error, /provider 500/);
  assert.equal(results[1].changeType, 'seeded');
});

test('ALERT_ON_FIRST_SYNC=true announces the first snapshot', async () => {
  const cache = createMemoryCache();
  const queue = createMemoryQueue();
  const dedup = createDedupService({ store: createMemoryDedupStore() });

  const ingestion = createIngestionService({
    client: createFixtureClient({
      'zone-a': [{ area: { id: 'zone-a', name: 'Zone A' }, stage: 4, events: [] }],
    }),
    cache,
    dedup,
    alertQueue: queue,
    logger: quiet,
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    alertOnFirstSync: true,
  });

  const [result] = await ingestion.run();
  assert.equal(result.changeType, 'initial');
  assert.equal(queue.jobs.length, 1);
});
