import { Queue, Worker } from 'bullmq';
import { createDispatcher } from '../core/dispatcher.js';

/**
 * BullMQ wiring (SDD §2).
 *
 * One job per *recipient*, not one job per broadcast. The worker limiter then
 * throttles actual messages at 25/s. The first draft put the limiter on a
 * single fan-out job, which does nothing for the thousands of HTTP calls made
 * inside it.
 */
export const ALERT_QUEUE = 'alerts';
export const DEAD_LETTER_QUEUE = 'alerts-dead';

export function createAlertQueues({ connection }) {
  return {
    alerts: new Queue(ALERT_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: { age: 3_600, count: 5_000 },
        removeOnFail: { age: 86_400 },
      },
    }),
    deadLetter: new Queue(DEAD_LETTER_QUEUE, { connection }),
  };
}

export function startAlertWorker({
  connection,
  subscribers,
  transport,
  bucket = null,
  logger = console,
  maxPerSecond = 25,
  concurrency = 8,
}) {
  const queues = createAlertQueues({ connection });
  const dispatcher = createDispatcher({ subscribers, transport, bucket, logger });

  const worker = new Worker(
    ALERT_QUEUE,
    async (job) => {
      if (job.name === 'fanout') {
        const { zoneId, message, eventId } = job.data;
        return dispatcher.fanout({
          zoneId,
          message,
          eventId,
          enqueue: (payload) =>
            queues.alerts.add('send', payload, {
              // Stable id: a retried fan-out cannot enqueue the same message twice.
              jobId: `send:${payload.eventId}:${payload.userId}`,
            }),
        });
      }

      if (job.name === 'send') {
        return dispatcher.deliver(job.data);
      }

      throw new Error(`Unknown job name: ${job.name}`);
    },
    {
      connection,
      concurrency,
      // Hard ceiling at the worker level: Telegram allows 30/s, we target 25.
      limiter: { max: maxPerSecond, duration: 1_000 },
    },
  );

  worker.on('failed', async (job, error) => {
    if (!job) return;
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    logger.error?.(
      { jobId: job.id, name: job.name, err: error?.message },
      'job exhausted retries; moving to dead-letter queue',
    );

    try {
      await queues.deadLetter.add('dead', {
        originalJobId: job.id,
        name: job.name,
        data: job.data,
        error: error?.message ?? 'unknown',
        failedAt: new Date().toISOString(),
      });
    } catch (deadLetterError) {
      logger.error?.({ err: deadLetterError.message }, 'could not write to dead-letter queue');
    }
  });

  worker.on('error', (error) => {
    logger.error?.({ err: error.message }, 'alert worker error');
  });

  return {
    ...queues,
    worker,
    async close() {
      await worker.close();
      await queues.alerts.close();
      await queues.deadLetter.close();
    },
  };
}
