import pino from 'pino';

/**
 * Structured logs only. Phone numbers and chat ids must never be logged in
 * full: log the tail, not the identifier (POPIA data minimisation).
 */
export function createLogger(level = 'info') {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: ['userId', '*.userId', 'chatId', '*.chatId', 'token', '*.token'],
      censor: '[redacted]',
    },
  });
}

/** "1234567890" -> "***7890" for the few places a human needs to correlate. */
export function maskId(userId) {
  const value = String(userId ?? '');
  if (value.length <= 4) return '***';
  return `***${value.slice(-4)}`;
}
