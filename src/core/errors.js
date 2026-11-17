/**
 * Error taxonomy used by the delivery pipeline.
 *
 * The queue decides whether to retry based on these types, so they are part of
 * the core contract rather than an implementation detail of the Telegram client.
 */

export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

/** Thrown before a provider call when the local daily credit budget is spent. */
export class QuotaExceededError extends Error {
  constructor(message = 'Daily provider credit budget exhausted') {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = 'QUOTA_EXCEEDED';
  }
}

/** Transient failure: network, timeout, 429, 5xx. Safe to retry. */
export class RetryableError extends Error {
  constructor(message, { retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'RetryableError';
    this.retryable = true;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

/** Deterministic failure: bad chat id, bot blocked, malformed payload. Do not retry. */
export class PermanentError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
    if (cause) this.cause = cause;
  }
}
