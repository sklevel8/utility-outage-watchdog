import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySubscriberRepo } from '../src/adapters/memory.js';
import { createSubscriberService } from '../src/core/subscribers.js';
import { ValidationError } from '../src/core/errors.js';

const setup = () => {
  const repo = createMemorySubscriberRepo();
  return { repo, service: createSubscriberService({ repo }) };
};

test('subscribe stores an explicit opt-in with a consent timestamp', async () => {
  const { repo, service } = setup();
  const subscription = await service.subscribe({
    platform: 'telegram',
    userId: '1001',
    zoneId: 'zone-a',
  });

  assert.equal(subscription.status, 'active');
  assert.ok(subscription.consentAt);

  const stored = await repo.getByUserId('telegram', '1001');
  assert.equal(stored.zoneId, 'zone-a');
  assert.match(stored.consentText, /consent/i);
});

test('re-subscribing moves the zone but keeps the original consent timestamp', async () => {
  const { service } = setup();
  const first = await service.subscribe({ platform: 'telegram', userId: '1001', zoneId: 'zone-a' });
  const second = await service.subscribe({ platform: 'telegram', userId: '1001', zoneId: 'zone-b' });

  assert.equal(second.zoneId, 'zone-b');
  assert.equal(second.consentAt, first.consentAt);
});

test('/stop is a hard delete, not a status update', async () => {
  const { repo, service } = setup();
  await service.subscribe({ platform: 'telegram', userId: '1001', zoneId: 'zone-a' });

  const result = await service.unsubscribe({ platform: 'telegram', userId: '1001' });

  assert.equal(result.deleted, 1);
  assert.equal(await repo.getByUserId('telegram', '1001'), null);
  assert.equal(repo.all().length, 0);
});

test('unsubscribe is idempotent and safe to repeat', async () => {
  const { service } = setup();
  await service.subscribe({ platform: 'telegram', userId: '1001', zoneId: 'zone-a' });
  assert.equal((await service.unsubscribe({ platform: 'telegram', userId: '1001' })).deleted, 1);
  assert.equal((await service.unsubscribe({ platform: 'telegram', userId: '1001' })).deleted, 0);
});

test('invalid zone ids never reach the database', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.subscribe({ platform: 'telegram', userId: '1001', zoneId: 'Not A Zone' }),
    (error) => error instanceof ValidationError && error.code === 'INVALID_ZONE',
  );
});

test('unsupported platforms are rejected', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.subscribe({ platform: 'sms', userId: '1001', zoneId: 'zone-a' }),
    /Unsupported platform/,
  );
});

test('empty or oversized user ids are rejected', async () => {
  const { service } = setup();
  await assert.rejects(() => service.subscribe({ platform: 'telegram', userId: '', zoneId: 'zone-a' }));
  await assert.rejects(() =>
    service.subscribe({ platform: 'telegram', userId: 'x'.repeat(129), zoneId: 'zone-a' }),
  );
});

test('recipients are paged, and paging covers every subscriber once', async () => {
  const { service } = setup();
  for (const userId of ['1', '2', '3', '4', '5']) {
    await service.subscribe({ platform: 'telegram', userId, zoneId: 'zone-a' });
  }
  await service.subscribe({ platform: 'telegram', userId: '6', zoneId: 'zone-b' });

  const pageOne = await service.listRecipients('zone-a', { limit: 2, offset: 0 });
  const pageTwo = await service.listRecipients('zone-a', { limit: 2, offset: 2 });
  const pageThree = await service.listRecipients('zone-a', { limit: 2, offset: 4 });

  assert.deepEqual(pageOne.map((row) => row.userId), ['1', '2']);
  assert.deepEqual(pageTwo.map((row) => row.userId), ['3', '4']);
  assert.deepEqual(pageThree.map((row) => row.userId), ['5']);
  assert.equal(await service.countRecipients('zone-a'), 5);
});

test('listRecipients validates its paging arguments', async () => {
  const { service } = setup();
  await assert.rejects(() => service.listRecipients('zone-a', { limit: 0 }));
  await assert.rejects(() => service.listRecipients('zone-a', { limit: 1001 }));
  await assert.rejects(() => service.listRecipients('zone-a', { offset: -1 }));
});
