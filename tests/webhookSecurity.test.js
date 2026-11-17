import test from 'node:test';
import assert from 'node:assert/strict';
import { authoriseWebhook, verifyTelegramSecret } from '../src/core/webhookSecurity.js';

const SECRET = 'correct-horse-battery-staple';

test('the expected secret is accepted', () => {
  assert.equal(verifyTelegramSecret(SECRET, SECRET), true);
});

test('a wrong, empty, or differently-sized secret is rejected', () => {
  assert.equal(verifyTelegramSecret('wrong', SECRET), false);
  assert.equal(verifyTelegramSecret('', SECRET), false);
  assert.equal(verifyTelegramSecret(undefined, SECRET), false);
  assert.equal(verifyTelegramSecret(SECRET + 'x', SECRET), false);
});

test('a configured secret rejects requests without the header', () => {
  assert.equal(authoriseWebhook({ headers: {}, secret: SECRET, allowInsecure: true }), false);
});

test('the header check is case-tolerant for header casing', () => {
  assert.equal(
    authoriseWebhook({
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      secret: SECRET,
      allowInsecure: false,
    }),
    true,
  );
  assert.equal(
    authoriseWebhook({
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      secret: SECRET,
      allowInsecure: false,
    }),
    true,
  );
});

test('insecure mode is only possible when no secret is configured', () => {
  assert.equal(authoriseWebhook({ headers: {}, secret: '', allowInsecure: true }), true);
  assert.equal(authoriseWebhook({ headers: {}, secret: '', allowInsecure: false }), false);
});
