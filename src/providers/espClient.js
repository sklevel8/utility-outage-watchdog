import { PermanentError, QuotaExceededError, RetryableError } from '../core/errors.js';

/**
 * EskomSePush client with a hard local credit budget.
 *
 * The free tier is roughly 50 requests/day. Polling every 15 minutes would be
 * 96/day, so the budget is enforced *before* the request and the interval is
 * validated at boot (see config/env.js). One runaway loop should never be able
 * to exhaust the account for the rest of the day.
 */
export function createEspClient({
  token,
  baseUrl,
  timeoutMs = 10_000,
  dailyCreditLimit = 48,
  budgetStore,
  logger = console,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = 2,
}) {
  if (!token) throw new Error('ESP token is required');
  if (!budgetStore) throw new Error('budgetStore is required');

  async function creditKey() {
    return `esp:credits:${new Date(now()).toISOString().slice(0, 10)}`;
  }

  async function consumeCredit() {
    const key = await creditKey();
    const used = await budgetStore.incr(key);
    if (used === 1) await budgetStore.expire(key, 90_000); // > 24h, safely past midnight
    if (used > dailyCreditLimit) {
      await budgetStore.decr(key); // do not count a request we never made
      throw new QuotaExceededError(
        `ESP daily credit budget of ${dailyCreditLimit} exhausted (used ${used - 1})`,
      );
    }
    return used;
  }

  async function refundCredit() {
    try {
      await budgetStore.decr(await creditKey());
    } catch (error) {
      logger.warn?.({ err: error.message }, 'failed to refund ESP credit');
    }
  }

  async function usage() {
    const key = await creditKey();
    return Number((await budgetStore.get(key)) ?? 0);
  }

  async function requestJson(pathname, { retries = maxRetries } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const used = await consumeCredit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}${pathname}`, {
          method: 'GET',
          headers: { Token: token, Accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.ok) {
          return await response.json();
        }

        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const body = await safeJson(response);

        if (response.status === 429) {
          await refundCredit();
          if (attempt < retries) {
            logger.warn?.({ attempt, used }, 'ESP rate limited; backing off');
            await sleep(retryAfterMs ?? 2 ** attempt * 1_000);
            continue;
          }
          throw new RetryableError('ESP rate limit (429)', { retryAfterMs });
        }

        if (response.status >= 500 && attempt < retries) {
          await refundCredit();
          logger.warn?.({ attempt, status: response.status }, 'ESP server error; retrying');
          await sleep(2 ** attempt * 750);
          continue;
        }

        await refundCredit();

        if (response.status >= 500) {
          throw new RetryableError(`ESP server error (${response.status})`);
        }
        if (response.status === 401 || response.status === 403) {
          throw new PermanentError(
            `ESP rejected the token or quota (${response.status}): ${body?.error ?? 'no detail'}`,
          );
        }
        if (response.status === 404) {
          throw new PermanentError(`ESP area/endpoint not found: ${pathname}`);
        }
        throw new PermanentError(`ESP request failed (${response.status})`);
      } catch (error) {
        if (error instanceof PermanentError || error instanceof RetryableError) throw error;
        if (error instanceof QuotaExceededError) throw error;

        const aborted = error?.name === 'AbortError';
        if (attempt < retries) {
          await refundCredit();
          logger.warn?.({ attempt, reason: aborted ? 'timeout' : error.message }, 'ESP request retry');
          await sleep(2 ** attempt * 500);
          continue;
        }
        throw new RetryableError(aborted ? 'ESP request timed out' : `ESP network error: ${error.message}`, {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    usage,
    /** GET /area?id=<areaId> – one credit. */
    async getArea(areaId) {
      const payload = await requestJson(`/area?id=${encodeURIComponent(areaId)}`);
      if (!payload || typeof payload !== 'object') {
        throw new RetryableError('ESP returned a non-object payload');
      }
      return payload;
    },
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
