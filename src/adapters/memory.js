/**
 * In-memory adapters.
 *
 * Used by the unit tests, the offline demo, and local development without
 * Redis/Postgres. They implement exactly the interfaces the production
 * adapters implement, so behaviour under test matches production wiring.
 */

export function createMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds = null) {
      store.set(key, {
        value: String(value),
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    size() {
      return store.size;
    },
  };
}

export function createMemorySubscriberRepo({ now = () => new Date() } = {}) {
  /** key: `${platform}:${userId}` -> record */
  const rows = new Map();

  return {
    async upsertActive({ platform, userId, zoneId, consentText, consentAt }) {
      const key = `${platform}:${userId}`;
      const existing = rows.get(key);
      rows.set(key, {
        platform,
        userId: String(userId),
        zoneId,
        status: 'active',
        consentText,
        consentAt: existing?.consentAt ?? consentAt,
        createdAt: existing?.createdAt ?? now().toISOString(),
        updatedAt: now().toISOString(),
      });
      return rows.get(key);
    },

    async deleteByUserId(platform, userId) {
      const key = `${platform}:${userId}`;
      return rows.delete(key) ? 1 : 0;
    },

    async getByUserId(platform, userId) {
      const row = rows.get(`${platform}:${userId}`);
      return row ? { ...row } : null;
    },

    async listActiveByZone(zoneId, { limit = 200, offset = 0 } = {}) {
      return [...rows.values()]
        .filter((row) => row.zoneId === zoneId && row.status === 'active')
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .slice(offset, offset + limit)
        .map((row) => ({ ...row }));
    },

    async countActiveByZone(zoneId) {
      return [...rows.values()].filter((row) => row.zoneId === zoneId && row.status === 'active')
        .length;
    },

    all() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
  };
}

export function createMemoryQueue() {
  const jobs = [];
  return {
    jobs,
    async add(name, data, options = {}) {
      const job = { id: options.jobId ?? `${name}:${jobs.length + 1}`, name, data, options };
      jobs.push(job);
      return job;
    },
    async close() {},
  };
}

/** Deterministic transport double for tests and the demo. */
export function createMemoryTransport({ failures = new Map() } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage({ userId, text }) {
      const rule = failures.get(String(userId));
      if (rule) {
        if (typeof rule === 'function') throw rule();
        throw rule;
      }
      sent.push({ userId: String(userId), text });
      return { messageId: sent.length };
    },
  };
}

/** Provider double: returns the configured payload per area, call by call. */
export function createFixtureClient(sequenceByArea) {
  const cursors = new Map();
  return {
    async getArea(areaId) {
      const sequence = sequenceByArea[areaId];
      if (!sequence || sequence.length === 0) {
        throw new Error(`No fixture for area ${areaId}`);
      }
      const index = Math.min(cursors.get(areaId) ?? 0, sequence.length - 1);
      cursors.set(areaId, index + 1);
      return structuredClone(sequence[index]);
    },
  };
}
