import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/core/ratelimit.js';

test('a full bucket allows its capacity and then refuses', () => {
  let clock = 0;
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: () => clock });

  assert.equal(bucket.tryTake(3), true);
  assert.equal(bucket.tryTake(1), false);
  assert.ok(bucket.available() < 1);
});

test('tokens refill at the configured rate', () => {
  let clock = 0;
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: () => clock });

  bucket.tryTake(3);
  clock += 1_000;
  assert.equal(bucket.tryTake(1), true);
  assert.equal(bucket.tryTake(1), false);
});

test('refill never exceeds capacity', () => {
  let clock = 0;
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 100, now: () => clock });
  clock += 60_000;
  assert.equal(bucket.available(), 5);
});

test('msUntilAvailability reports the wait for a token', () => {
  let clock = 0;
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, now: () => clock });

  bucket.tryTake(2);
  assert.equal(bucket.msUntilAvailability(1), 500);
  clock += 500;
  assert.equal(bucket.msUntilAvailability(1), 0);
});

test('clearTimeout-style waits are not needed: tryTake is non-blocking', () => {
  const bucket = new TokenBucket({ capacity: 25, refillPerSecond: 25 });
  const start = Date.now();
  for (let index = 0; index < 25; index += 1) bucket.tryTake(1);
  assert.equal(bucket.tryTake(1), false);
  assert.ok(Date.now() - start < 500, '25 takes must not block the event loop');
});

test('invalid configuration is rejected', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }), TypeError);
  assert.throws(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 }), TypeError);
});
