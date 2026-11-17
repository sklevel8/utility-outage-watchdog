import { PermanentError, RetryableError } from './errors.js';

/**
 * Delivery pipeline (SRS FR-4, SRS §4).
 *
 * Fixes the two structural bugs in the first draft:
 *  1. the provider rate limit is enforced per *message*, not per fan-out job;
 *  2. a recipient failure becomes a queue retry (exponential backoff), not a
 *     swallowed console.error.
 */

export function createDispatcher({
  subscribers,
  transport,
  bucket = null,
  logger = console,
  pageSize = 200,
}) {
  if (!subscribers) throw new TypeError('subscribers service is required');
  if (!transport) throw new TypeError('transport is required');

  /**
   * Fan-out: read subscribers in pages and hand each recipient to `enqueue`,
   * which turns it into its own retryable, rate-limited queue job.
   */
  async function fanout({
    zoneId,
    message,
    eventId,
    enqueue,
    maxRecipients = 100_000,
    pageSize: pageSizeOverride = null,
  }) {
    if (typeof enqueue !== 'function') throw new TypeError('enqueue callback is required');
    const limit = pageSizeOverride ?? pageSize;

    let offset = 0;
    let enqueued = 0;

    for (;;) {
      const page = await subscribers.listRecipients(zoneId, { limit, offset });
      if (page.length === 0) break;

      for (const recipient of page) {
        await enqueue({
          userId: recipient.userId ?? recipient.user_id,
          platform: recipient.platform ?? 'telegram',
          zoneId,
          message,
          eventId,
        });
        enqueued += 1;

        if (enqueued >= maxRecipients) {
          logger.warn?.({ zoneId, maxRecipients }, 'fan-out truncated at maxRecipients');
          return { zoneId, enqueued, truncated: true };
        }
      }

      // Short page => last page. Avoids one extra query per broadcast.
      if (page.length < limit) break;
      offset += limit;
    }

    return { zoneId, enqueued, truncated: false };
  }

  /** Deliver one message. Retryable failures are rethrown for the queue to back off. */
  async function deliver({ userId, platform = 'telegram', message, eventId = null }) {
    if (bucket && !bucket.tryTake(1)) {
      throw new RetryableError('local token bucket empty', {
        retryAfterMs: bucket.msUntilAvailability(1),
      });
    }

    try {
      const result = await transport.sendMessage({ userId, text: message, platform });
      return { userId, status: 'sent', messageId: result?.messageId ?? null };
    } catch (error) {
      if (error instanceof RetryableError || error?.retryable === true) throw error;

      if (error instanceof PermanentError || error?.permanent === true) {
        logger.warn?.(
          { userId, eventId, reason: error.message },
          'permanent delivery failure; not retrying',
        );
        return { userId, status: 'failed_permanent', error: error.message };
      }

      // Unknown errors are treated as transient: a lost alert is worse than a retry.
      throw new RetryableError(`transport error: ${error?.message ?? error}`, { cause: error });
    }
  }

  return { fanout, deliver };
}
