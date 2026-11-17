import { ValidationError } from './errors.js';
import { isValidZoneId } from './commands.js';

/**
 * Subscriber lifecycle (SRS FR-2, SRS §3, SDD §4).
 *
 * POPIA right to erasure is implemented as a real DELETE, never a status flag.
 * The repository is injected so the rule is testable without Postgres.
 */

const CONSENT_TEXT =
  'I consent to receive utility outage alerts for this zone. I understand I can withdraw consent at any time with /stop.';

export function createSubscriberService({ repo, now = () => new Date() }) {
  if (!repo) throw new TypeError('repo is required');

  return {
    consentText: CONSENT_TEXT,

    /**
     * Explicit opt-in. Calling twice is safe: the unique (platform, user_id)
     * constraint upserts, and consent timestamp is only set on first subscribe.
     */
    async subscribe({ platform, userId, zoneId }) {
      assertPlatform(platform);
      assertUserId(userId);
      if (!isValidZoneId(zoneId)) {
        throw new ValidationError(`Invalid zone id: ${zoneId}`, 'INVALID_ZONE');
      }

      const existing = await repo.getByUserId(platform, userId);
      const consentAt = existing?.consentAt ?? now().toISOString();

      await repo.upsertActive({
        platform,
        userId,
        zoneId,
        consentText: CONSENT_TEXT,
        consentAt,
      });

      return { platform, userId, zoneId, status: 'active', consentAt };
    },

    /** Hard delete. Returns how many rows were removed (0 is a valid, idempotent result). */
    async unsubscribe({ platform, userId }) {
      assertPlatform(platform);
      assertUserId(userId);
      const deleted = await repo.deleteByUserId(platform, userId);
      return { deleted: Number(deleted) || 0 };
    },

    async status({ platform, userId }) {
      assertPlatform(platform);
      assertUserId(userId);
      return repo.getByUserId(platform, userId);
    },

    /** Recipients for a broadcast, paged so a 1M-row zone never lands in memory at once. */
    async listRecipients(zoneId, { limit = 200, offset = 0 } = {}) {
      if (!isValidZoneId(zoneId)) throw new ValidationError(`Invalid zone id: ${zoneId}`);
      if (!(limit > 0 && limit <= 1000)) throw new ValidationError('limit must be 1..1000');
      if (!(offset >= 0)) throw new ValidationError('offset must be >= 0');
      return repo.listActiveByZone(zoneId, { limit, offset });
    },

    async countRecipients(zoneId) {
      return repo.countActiveByZone(zoneId);
    },
  };
}

function assertPlatform(platform) {
  if (platform !== 'telegram' && platform !== 'whatsapp') {
    throw new ValidationError(`Unsupported platform: ${platform}`, 'INVALID_PLATFORM');
  }
}

function assertUserId(userId) {
  const value = String(userId ?? '');
  if (value.length === 0 || value.length > 128) {
    throw new ValidationError('userId must be 1..128 characters', 'INVALID_USER_ID');
  }
}
