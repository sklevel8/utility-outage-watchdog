import { PermanentError, RetryableError } from '../core/errors.js';

/**
 * Telegram transport.
 *
 * Maps provider responses onto the retry taxonomy:
 *   429            -> RetryableError (honour retry_after)
 *   5xx / timeout  -> RetryableError
 *   400 / 403      -> PermanentError (bad chat id, bot blocked)
 */
export function createTelegramTransport({
  token,
  apiBase = 'https://api.telegram.org',
  timeoutMs = 10_000,
}) {
  if (!token) throw new Error('Telegram token is required');

  return {
    async sendMessage({ userId, text }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${apiBase.replace(/\/$/, '')}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(userId),
            text,
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        });

        const body = await response.json().catch(() => ({}));

        if (response.ok && body.ok) {
          return { messageId: body.result?.message_id ?? null };
        }

        if (response.status === 429) {
          throw new RetryableError('Telegram rate limit (429)', {
            retryAfterMs: Number(body.parameters?.retry_after ?? 1) * 1000,
          });
        }
        if (response.status >= 500) {
          throw new RetryableError(`Telegram server error (${response.status})`);
        }
        throw new PermanentError(
          `Telegram rejected message (${response.status}): ${body.description ?? 'no detail'}`,
        );
      } catch (error) {
        if (error instanceof PermanentError || error instanceof RetryableError) throw error;
        if (error?.name === 'AbortError') {
          throw new RetryableError('Telegram request timed out');
        }
        throw new RetryableError(`Telegram network error: ${error.message}`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
