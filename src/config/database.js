import knex from 'knex';

export function createDatabase(databaseUrl, logger = console) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const db = knex({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 0, max: 10, idleTimeoutMillis: 30_000 },
  });

  db.on('query-error', (error) => logger.error?.({ err: error.message }, 'query error'));
  return db;
}

/**
 * Repository over the `subscribers` table.
 *
 * Note the absence of an updateStatus() helper: withdrawal of consent is a
 * DELETE (POPIA / SRS §3). Keeping the method surface small makes it hard to
 * reintroduce a soft delete by accident.
 */
export function createSubscriberRepo(db, { now = () => new Date() } = {}) {
  return {
    async upsertActive({ platform, userId, zoneId, consentText, consentAt }) {
      const [row] = await db('subscribers')
        .insert({
          platform,
          user_id: String(userId),
          zone_id: zoneId,
          status: 'active',
          consent_text: consentText,
          consent_at: consentAt ?? now().toISOString(),
          updated_at: now().toISOString(),
        })
        .onConflict(['platform', 'user_id'])
        .merge({
          zone_id: zoneId,
          status: 'active',
          updated_at: now().toISOString(),
        })
        .returning(['platform', 'user_id', 'zone_id', 'status', 'consent_at']);
      return toRecord(row);
    },

    async deleteByUserId(platform, userId) {
      return db('subscribers').where({ platform, user_id: String(userId) }).del();
    },

    async getByUserId(platform, userId) {
      const row = await db('subscribers')
        .where({ platform, user_id: String(userId) })
        .first();
      return row ? toRecord(row) : null;
    },

    async listActiveByZone(zoneId, { limit = 200, offset = 0 } = {}) {
      const rows = await db('subscribers')
        .where({ zone_id: zoneId, status: 'active' })
        .orderBy('user_id', 'asc')
        .limit(limit)
        .offset(offset);
      return rows.map(toRecord);
    },

    async countActiveByZone(zoneId) {
      const [{ count }] = await db('subscribers')
        .where({ zone_id: zoneId, status: 'active' })
        .count({ count: '*' });
      return Number(count);
    },
  };
}

function toRecord(row) {
  return {
    platform: row.platform,
    userId: row.user_id,
    zoneId: row.zone_id,
    status: row.status,
    consentAt: row.consent_at instanceof Date ? row.consent_at.toISOString() : row.consent_at,
  };
}
