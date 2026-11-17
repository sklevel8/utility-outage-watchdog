import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDedupService,
  createMemoryDedupStore,
  dedupKey,
} from '../src/core/dedup.js';

test('dedup key is namespaced by zone and event', () => {
  assert.equal(dedupKey('zone-a', 'stage-6'), 'alert_sent:zone-a:stage-6');
});

test('dedup key builders reject unsafe input', () => {
  assert.throws(() => dedupKey('', 'stage-6'), TypeError);
  assert.throws(() => dedupKey('zone a', 'stage-6'), TypeError);
  assert.throws(() => dedupKey('zone-a', ''), TypeError);
  assert.throws(() => dedupKey('zone-a', 'x'.repeat(201)), TypeError);
});

test('first claim wins, second claim within the window is suppressed', async () => {
  const dedup = createDedupService({ store: createMemoryDedupStore() });

  const first = await dedup.claim('zone-a', 'stage-6');
  const second = await dedup.claim('zone-a', 'stage-6');

  assert.equal(first.won, true);
  assert.equal(second.won, false);
  assert.equal(second.key, 'alert_sent:zone-a:stage-6');
});

test('different zones do not block each other', async () => {
  const dedup = createDedupService({ store: createMemoryDedupStore() });
  assert.equal((await dedup.claim('zone-a', 'stage-6')).won, true);
  assert.equal((await dedup.claim('zone-b', 'stage-6')).won, true);
});

test('claim expires after the TTL so tomorrow\'s event can be sent', async () => {
  let clock = 1_000;
  const store = createMemoryDedupStore({ now: () => clock });
  const dedup = createDedupService({ store, ttlSeconds: 10 });

  assert.equal((await dedup.claim('zone-a', 'stage-6')).won, true);
  assert.equal((await dedup.claim('zone-a', 'stage-6')).won, false);

  clock += 10_001;
  assert.equal((await dedup.claim('zone-a', 'stage-6')).won, true);
});

test('a store without setIfAbsent is rejected at construction', () => {
  assert.throws(() => createDedupService({ store: {} }), TypeError);
});
