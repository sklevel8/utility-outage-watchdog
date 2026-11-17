import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySubscriberRepo, createMemoryTransport } from '../src/adapters/memory.js';
import { createDispatcher } from '../src/core/dispatcher.js';
import { PermanentError, RetryableError } from '../src/core/errors.js';
import { TokenBucket } from '../src/core/ratelimit.js';
import { createSubscriberService } from '../src/core/subscribers.js';

const quiet = { info() {}, warn() {}, error() {} };

async function setup({ failures = new Map(), capacity = 100 } = {}) {
  const repo = createMemorySubscriberRepo();
  const subscribers = createSubscriberService({ repo });
  const transport = createMemoryTransport({ failures });
  const bucket = new TokenBucket({ capacity, refillPerSecond: capacity });
  const dispatcher = createDispatcher({ subscribers, transport, bucket, logger: quiet });

  for (const userId of ['1', '2', '3', '4', '5']) {
    await subscribers.subscribe({ platform: 'telegram', userId, zoneId: 'zone-a' });
  }

  return { repo, subscribers, transport, dispatcher };
}

test('deliver sends one message and reports success', async () => {
  const { transport, dispatcher } = await setup();
  const result = await dispatcher.deliver({ userId: '1', message: 'hello' });

  assert.equal(result.status, 'sent');
  assert.equal(transport.sent.length, 1);
});

test('a permanent failure is recorded and not retried', async () => {
  const { dispatcher } = await setup({ failures: new Map([['2', new PermanentError('bot blocked')]]) });
  const result = await dispatcher.deliver({ userId: '2', message: 'hello' });

  assert.equal(result.status, 'failed_permanent');
  assert.match(result.error, /blocked/);
});

test('a retryable failure is rethrown so the queue applies backoff', async () => {
  const { dispatcher } = await setup({ failures: new Map([['3', new RetryableError('timeout')]]) });
  await assert.rejects(() => dispatcher.deliver({ userId: '3', message: 'hello' }), RetryableError);
});

test('an unknown error is treated as transient, never silently dropped', async () => {
  const { dispatcher } = await setup({ failures: new Map([['4', new Error('ECONNRESET')]]) });
  await assert.rejects(() => dispatcher.deliver({ userId: '4', message: 'hello' }), RetryableError);
});

test('an empty token bucket produces a retry hint instead of a 429 from Telegram', async () => {
  const { subscribers, transport } = await setup();
  const dispatcher = createDispatcher({
    subscribers,
    transport,
    bucket: new TokenBucket({ capacity: 1, refillPerSecond: 1 }),
    logger: quiet,
  });

  await dispatcher.deliver({ userId: '1', message: 'first' });
  await assert.rejects(
    () => dispatcher.deliver({ userId: '2', message: 'second' }),
    (error) => error instanceof RetryableError && error.retryAfterMs >= 900,
  );
});

test('fan-out pages through every subscriber exactly once', async () => {
  const { dispatcher } = await setup();
  const seen = [];

  const result = await dispatcher.fanout({
    zoneId: 'zone-a',
    message: 'hello',
    eventId: 'stage-6',
    pageSize: 2,
    enqueue: async (payload) => seen.push(payload.userId),
  });

  assert.equal(result.enqueued, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(seen, ['1', '2', '3', '4', '5']);
});

test('an empty zone enqueues nothing', async () => {
  const { dispatcher } = await setup();
  const seen = [];
  const result = await dispatcher.fanout({
    zoneId: 'zone-empty',
    message: 'hello',
    eventId: 'stage-6',
    enqueue: async (payload) => seen.push(payload.userId),
  });

  assert.equal(result.enqueued, 0);
  assert.deepEqual(seen, []);
});

test('fan-out stops at maxRecipients rather than looping forever', async () => {
  const { dispatcher } = await setup();
  const seen = [];
  const result = await dispatcher.fanout({
    zoneId: 'zone-a',
    message: 'hello',
    eventId: 'stage-6',
    pageSize: 2,
    maxRecipients: 3,
    enqueue: async (payload) => seen.push(payload.userId),
  });

  assert.equal(result.enqueued, 3);
  assert.equal(result.truncated, true);
});

test('a subscriber who sends /stop during a broadcast is skipped for later pages', async () => {
  const { subscribers, dispatcher } = await setup();
  const seen = [];

  const result = await dispatcher.fanout({
    zoneId: 'zone-a',
    message: 'hello',
    eventId: 'stage-6',
    pageSize: 1,
    enqueue: async (payload) => {
      seen.push(payload.userId);
      // Simulate the user deleting themselves mid-broadcast.
      if (payload.userId === '1') {
        await subscribers.unsubscribe({ platform: 'telegram', userId: '5' });
      }
    },
  });

  assert.equal(result.enqueued, 4);
  assert.ok(!seen.includes('5'));
});
