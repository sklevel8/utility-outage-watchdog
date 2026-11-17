import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDedupStore } from '../src/core/dedup.js';
import { createWebhookServer } from '../src/webhooks/server.js';

/**
 * HTTP-level tests for the webhook surface. These catch wiring mistakes that
 * unit tests cannot see: middleware order, status codes, and the fact that the
 * handler actually runs after the acknowledgement.
 */

const quiet = { info() {}, warn() {}, error() {} };
const SECRET = 's3cret-token';

async function withServer(options, run) {
  const handled = [];
  const app = createWebhookServer({
    handler: async (update) => {
      handled.push(update);
    },
    dedupeStore: createMemoryDedupStore(),
    secret: SECRET,
    logger: quiet,
    ...options,
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ base, handled });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('GET /healthz reports liveness', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
  });
});

test('GET /readyz reports each dependency', async () => {
  await withServer(
    { healthChecks: { redis: async () => true, postgres: async () => true } },
    async ({ base }) => {
      const response = await fetch(`${base}/readyz`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).checks, { redis: 'ok', postgres: 'ok' });
    },
  );
});

test('GET /readyz returns 503 when a dependency is down', async () => {
  await withServer(
    { healthChecks: { redis: async () => true, postgres: async () => false } },
    async ({ base }) => {
      const response = await fetch(`${base}/readyz`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).checks.postgres, /fail/);
    },
  );
});

test('a webhook without the secret header is rejected and never handled', async () => {
  await withServer({}, async ({ base, handled }) => {
    const response = await fetch(`${base}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 1, message: { chat: { id: 5 }, text: '/stop' } }),
    });

    assert.equal(response.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(handled.length, 0);
  });
});

test('an authenticated update is acknowledged and then handled', async () => {
  await withServer({}, async ({ base, handled }) => {
    const update = { update_id: 42, message: { chat: { id: 5 }, text: '/help' } };
    const response = await fetch(`${base}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify(update),
    });

    assert.equal(response.status, 200);
    assert.equal(await waitFor(() => handled.length === 1), true);
    assert.equal(handled[0].update_id, 42);
  });
});

test('a replayed update_id is acknowledged but handled only once', async () => {
  await withServer({}, async ({ base, handled }) => {
    const update = { update_id: 77, message: { chat: { id: 5 }, text: '/help' } };
    const send = () =>
      fetch(`${base}/webhooks/telegram`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': SECRET,
        },
        body: JSON.stringify(update),
      });

    await send();
    const second = await send();
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicate, true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handled.length, 1);
  });
});

test('an invalid body shape is refused with 400', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify([]),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_update');
  });
});

test('unknown routes return a JSON 404', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not_found');
  });
});

test('a handler that throws does not crash the process', async () => {
  await withServer(
    {
      handler: async () => {
        throw new Error('database exploded');
      },
    },
    async ({ base }) => {
      const response = await fetch(`${base}/webhooks/telegram`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': SECRET,
        },
        body: JSON.stringify({ update_id: 100, message: { chat: { id: 5 }, text: '/status' } }),
      });

      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200, 'server still serving after a handler crash');
    },
  );
});
