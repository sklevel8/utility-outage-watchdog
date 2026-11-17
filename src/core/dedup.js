/**
 * Alert de-duplication (SRS §3, SDD §4).
 *
 * Uses SET NX EX semantics so two workers polling at once cannot both claim the
 * same alert. The store interface is intentionally tiny so tests can use memory.
 */

export const DEDUP_TTL_SECONDS = 86_400;

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,200}$/;

export function dedupKey(zoneId, eventId) {
  if (!zoneId || !SAFE_ID.test(String(zoneId))) {
    throw new TypeError(`Invalid zoneId for dedup key: ${zoneId}`);
  }
  if (!eventId || !SAFE_ID.test(String(eventId))) {
    throw new TypeError(`Invalid eventId for dedup key: ${eventId}`);
  }
  return `alert_sent:${zoneId}:${eventId}`;
}

/**
 * @param {{ setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> }} store
 */
export function createDedupService({ store, ttlSeconds = DEDUP_TTL_SECONDS }) {
  if (!store || typeof store.setIfAbsent !== 'function') {
    throw new TypeError('dedup store must implement setIfAbsent()');
  }

  return {
    ttlSeconds,

    /** true when this caller won the claim and should send; false when suppressed. */
    async claim(zoneId, eventId) {
      const key = dedupKey(zoneId, eventId);
      const won = await store.setIfAbsent(key, new Date().toISOString(), ttlSeconds);
      return { won: won === true, key };
    },
  };
}

/** In-memory implementation used by tests and the offline demo. */
export function createMemoryDedupStore({ now = () => Date.now() } = {}) {
  const entries = new Map();

  return {
    async setIfAbsent(key, value, ttlSeconds) {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) return false;
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
