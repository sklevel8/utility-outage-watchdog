import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication.
 *
 * Telegram supports a shared secret sent as X-Telegram-Bot-Api-Secret-Token.
 * Without it, anyone who learns the URL can forge a /stop update and erase
 * other users' subscriptions.
 */

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

/** Constant-time comparison; hashing first keeps length differences from leaking. */
export function verifyTelegramSecret(provided, expected) {
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  try {
    return timingSafeEqual(digest(provided), digest(expected));
  } catch {
    return false;
  }
}

/**
 * Polling fallback for local development only. Never allow an unauthenticated
 * webhook in production, whatever the NODE_ENV says in a lagging config map.
 */
export function authoriseWebhook({ headers, secret, allowInsecure }) {
  if (!secret) return allowInsecure === true;
  const provided =
    headers['x-telegram-bot-api-secret-token'] ??
    headers['X-Telegram-Bot-Api-Secret-Token'];
  return verifyTelegramSecret(provided, secret);
}
