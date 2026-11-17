/**
 * Local token bucket, used as a second line of defence in front of the
 * messaging provider (SRS §4). The queue limiter protects the account; this
 * protects against a single burst job or a second worker process.
 *
 * Clock is injectable so tests are deterministic.
 */
export class TokenBucket {
  constructor({ capacity, refillPerSecond, now = () => Date.now() }) {
    if (!(capacity > 0)) throw new TypeError('capacity must be > 0');
    if (!(refillPerSecond > 0)) throw new TypeError('refillPerSecond must be > 0');

    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  #refill(at) {
    const elapsedSeconds = Math.max(0, (at - this.updatedAt) / 1000);
    if (elapsedSeconds === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = at;
  }

  /** Non-blocking take. Returns false when the caller should back off. */
  tryTake(count = 1) {
    if (!(count > 0)) throw new TypeError('count must be > 0');
    this.#refill(this.now());
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  available() {
    this.#refill(this.now());
    return this.tokens;
  }

  /** Milliseconds until `count` tokens are available. Used for Retry-After hints. */
  msUntilAvailability(count = 1) {
    this.#refill(this.now());
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.refillPerSecond) * 1000);
  }
}
