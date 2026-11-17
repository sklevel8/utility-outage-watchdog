import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) {
  // Node >= 20.12 built-in .env support: no dotenv dependency.
  process.loadEnvFile(envPath);
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number`);
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * WATCH_ZONES="id:Display Name,id2:Display Name 2"
 * The display name is used in alert copy; the id is what the ESP API takes.
 */
export function parseZones(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (separator === -1) return { id: entry, name: entry };
      return {
        id: entry.slice(0, separator).trim(),
        name: entry.slice(separator + 1).trim() || entry.slice(0, separator).trim(),
      };
    });
}

export function loadConfig({ requireSecrets = true } = {}) {
  const provider = (process.env.ESP_PROVIDER ?? 'fixture').toLowerCase();
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const espToken = process.env.ESP_API_TOKEN ?? '';
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

  if (!['esp', 'fixture'].includes(provider)) {
    throw new Error('ESP_PROVIDER must be "esp" or "fixture"');
  }

  const zones = parseZones(process.env.WATCH_ZONES);
  if (requireSecrets && zones.length === 0) {
    throw new Error('WATCH_ZONES is empty: at least one zone must be configured');
  }

  if (requireSecrets && provider === 'esp' && !espToken) {
    throw new Error('ESP_API_TOKEN is required when ESP_PROVIDER=esp');
  }
  if (requireSecrets && !telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  if (requireSecrets && !webhookSecret) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required (webhook authentication)');
  }

  const maxPerSecond = num('TELEGRAM_MAX_PER_SECOND', 25);
  if (maxPerSecond > 30) {
    throw new Error('TELEGRAM_MAX_PER_SECOND must be <= 30 (Telegram hard limit)');
  }

  const dailyCreditLimit = num('ESP_DAILY_CREDIT_LIMIT', 48);
  const ingestIntervalMs = num('INGEST_INTERVAL_MS', 900_000);
  const minimumInterval = Math.ceil((86_400 / Math.max(dailyCreditLimit, 1)) * 1000);
  if (ingestIntervalMs < minimumInterval) {
    throw new Error(
      `INGEST_INTERVAL_MS=${ingestIntervalMs} would exceed the ${dailyCreditLimit}/day credit budget ` +
        `for ${zones.length || 1} zone(s) (minimum ${minimumInterval}ms).`,
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    port: num('PORT', 3000),
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    databaseUrl: process.env.DATABASE_URL ?? '',
    esp: {
      provider,
      token: espToken,
      baseUrl: process.env.ESP_API_BASE ?? 'https://developer.sepush.co.za/business/2.0',
      timeoutMs: num('ESP_TIMEOUT_MS', 10_000),
      dailyCreditLimit,
    },
    zones,
    ingestIntervalMs,
    alertOnFirstSync: bool('ALERT_ON_FIRST_SYNC', false),
    telegram: {
      token: telegramToken,
      apiBase: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
      webhookSecret,
      maxPerSecond,
    },
    dedupTtlSeconds: num('DEDUP_TTL_SECONDS', 86_400),
    retentionDays: num('ALERT_HISTORY_RETENTION_DAYS', 90),
  };
}
