import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createDatabase, createSubscriberRepo } from './config/database.js';
import { createRedis, createRedisDedupStore } from './config/redis.js';
import { createDedupService } from './core/dedup.js';
import { TokenBucket } from './core/ratelimit.js';
import { createSubscriberService } from './core/subscribers.js';
import { createUtilityClient } from './providers/index.js';
import { createIngestionService } from './services/ingestion.js';
import { createTelegramTransport } from './services/telegram.js';
import { startAlertWorker } from './workers/alertWorker.js';
import { createUpdateHandler } from './webhooks/handleUpdate.js';
import { createWebhookServer } from './webhooks/server.js';

const instanceId = randomUUID();

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const redis = createRedis(config.redisUrl, logger);
  const db = createDatabase(config.databaseUrl, logger);

  await redis.ping();
  await db.raw('select 1');
  logger.info('redis and postgres reachable');

  const repo = createSubscriberRepo(db);
  const subscribers = createSubscriberService({ repo });
  const dedup = createDedupService({
    store: createRedisDedupStore(redis),
    ttlSeconds: config.dedupTtlSeconds,
  });

  const transport = createTelegramTransport({
    token: config.telegram.token,
    apiBase: config.telegram.apiBase,
  });

  const client = createUtilityClient(config.esp, { budgetStore: redis, logger });

  const bucket = new TokenBucket({
    capacity: config.telegram.maxPerSecond,
    refillPerSecond: config.telegram.maxPerSecond,
  });

  const workerBundle = startAlertWorker({
    connection: redis,
    subscribers,
    transport,
    bucket,
    logger,
    maxPerSecond: config.telegram.maxPerSecond,
  });

  const ingestion = createIngestionService({
    client,
    cache: redis,
    dedup,
    alertQueue: workerBundle.alerts,
    logger,
    zones: config.zones,
    alertOnFirstSync: config.alertOnFirstSync,
  });

  const handler = createUpdateHandler({
    subscribers,
    transport,
    zones: config.zones,
    logger,
  });

  const app = createWebhookServer({
    handler,
    dedupeStore: createRedisDedupStore(redis),
    secret: config.telegram.webhookSecret,
    allowInsecure: config.nodeEnv !== 'production',
    logger,
    healthChecks: {
      redis: async () => (await redis.ping()) === 'PONG',
      postgres: async () => Boolean(await db.raw('select 1')),
    },
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, zones: config.zones.length }, 'webhook server listening');
  });

  /**
   * Advisory lock so a second instance (or a restart overlap) cannot double-poll
   * and burn credits. TTL is shorter than the interval, so a crashed holder
   * releases the lock automatically.
   */
  async function tick() {
    const lockTtl = Math.max(30, Math.floor((config.ingestIntervalMs / 1000) * 0.9));
    const acquired = await redis.set('lock:ingestion', instanceId, 'EX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      logger.warn?.('ingestion skipped: another instance holds the lock');
      return;
    }
    try {
      await ingestion.run();
    } catch (error) {
      logger.error?.({ err: error.message }, 'ingestion cycle threw');
    }
  }

  const timer = setInterval(tick, config.ingestIntervalMs);
  logger.info({ intervalMs: config.ingestIntervalMs }, 'ingestion scheduler started');
  void tick();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));

    try {
      await workerBundle.close();
    } catch (error) {
      logger.warn?.({ err: error.message }, 'error closing worker');
    }

    await redis.quit().catch(() => {});
    await db.destroy().catch(() => {});
    logger.info('shutdown complete');
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('fatal boot error:', error.message);
  process.exitCode = 1;
});
