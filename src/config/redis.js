import Redis from 'ioredis';

/**
 * Redis is both the schedule cache and the BullMQ broker (SDD §1).
 * Connection is lazy so unit tests never touch the network.
 */
export function createRedis(url, logger = console) {
  const client = new Redis(url, {
    maxRetriesPerRequest: null, // required by BullMQ blocking commands
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 200, 5_000);
    },
  });

  client.on('error', (error) => logger.error?.({ err: error.message }, 'redis error'));
  client.on('reconnecting', () => logger.warn?.('redis reconnecting'));
  return client;
}

/**
 * SET NX EX wrapper used by the de-duplication engine.
 * Returns true only for the caller that created the key.
 */
export function createRedisDedupStore(client) {
  return {
    async setIfAbsent(key, value, ttlSeconds) {
      const result = await client.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)), 'NX');
      return result === 'OK';
    },
  };
}
