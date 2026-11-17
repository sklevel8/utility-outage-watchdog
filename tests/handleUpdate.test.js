import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySubscriberRepo, createMemoryTransport } from '../src/adapters/memory.js';
import { createSubscriberService } from '../src/core/subscribers.js';
import { createUpdateHandler } from '../src/webhooks/handleUpdate.js';

const quiet = { info() {}, warn() {}, error() {} };
const ZONES = [{ id: 'zone-a', name: 'Zone A' }];

function setup() {
  const repo = createMemorySubscriberRepo();
  const subscribers = createSubscriberService({ repo });
  const transport = createMemoryTransport();
  const handler = createUpdateHandler({ subscribers, transport, zones: ZONES, logger: quiet });
  return { repo, subscribers, transport, handler };
}

const textUpdate = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1_000_000),
  message: { chat: { id: chatId }, text },
});

test('/subscribe creates the subscription and confirms it', async () => {
  const { repo, transport, handler } = setup();
  const result = await handler(textUpdate(1001, '/subscribe zone-a'));

  assert.equal(result.handled, true);
  assert.equal(result.command, 'subscribe');
  assert.equal((await repo.getByUserId('telegram', '1001')).zoneId, 'zone-a');
  assert.match(transport.sent[0].text, /Subscribed to zone-a/);
});

test('/subscribe to an unmonitored zone is refused', async () => {
  const { repo, transport, handler } = setup();
  const result = await handler(textUpdate(1001, '/subscribe zone-z'));

  assert.equal(result.error, 'UNKNOWN_ZONE');
  assert.equal(await repo.getByUserId('telegram', '1001'), null);
  assert.match(transport.sent[0].text, /not being monitored/);
});

test('/subscribe without an argument explains the format', async () => {
  const { transport, handler } = setup();
  const result = await handler(textUpdate(1001, '/subscribe'));

  assert.equal(result.error, 'MISSING_ZONE');
  assert.match(transport.sent[0].text, /\/subscribe city-of-tshwane/);
});

test('/stop erases the row and says so', async () => {
  const { repo, transport, handler } = setup();
  await handler(textUpdate(1001, '/subscribe zone-a'));
  const result = await handler(textUpdate(1001, '/stop'));

  assert.equal(result.deleted, 1);
  assert.equal(await repo.getByUserId('telegram', '1001'), null);
  assert.match(transport.sent.at(-1).text, /permanently deleted/);
});

test('/status reports the current zone and reports absence correctly', async () => {
  const { transport, handler } = setup();
  await handler(textUpdate(1001, '/status'));
  assert.match(transport.sent.at(-1).text, /not subscribed/);

  await handler(textUpdate(1001, '/subscribe zone-a'));
  await handler(textUpdate(1001, '/status'));
  assert.match(transport.sent.at(-1).text, /zone-a/);
});

test('/start and /help return guidance without touching the database', async () => {
  const { repo, transport, handler } = setup();
  await handler(textUpdate(1001, '/start'));
  await handler(textUpdate(1001, '/help'));

  assert.equal(repo.all().length, 0);
  assert.match(transport.sent[0].text, /Welcome/);
  assert.match(transport.sent[1].text, /\/subscribe/);
});

test('blocking the bot purges the subscription (withdrawal of consent)', async () => {
  const { repo, handler } = setup();
  await handler(textUpdate(1001, '/subscribe zone-a'));

  const result = await handler({
    update_id: 9,
    my_chat_member: { chat: { id: 1001 }, new_chat_member: { status: 'kicked' } },
  });

  assert.equal(result.action, 'purged_blocked_user');
  assert.equal(await repo.getByUserId('telegram', '1001'), null);
});

test('non-text updates are ignored, not crashed on', async () => {
  const { handler } = setup();
  assert.deepEqual(await handler({ update_id: 1, message: { chat: { id: 1 }, sticker: {} } }), {
    handled: false,
    reason: 'no_text',
  });
  assert.deepEqual(await handler({ update_id: 2 }), { handled: false, reason: 'no_text' });
});

test('an unknown command replies with help instead of silence', async () => {
  const { transport, handler } = setup();
  const result = await handler(textUpdate(1001, '/banana'));

  assert.equal(result.command, 'unknown');
  assert.match(transport.sent[0].text, /Available commands/);
});
