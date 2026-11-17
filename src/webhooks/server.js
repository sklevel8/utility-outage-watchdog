import express from 'express';
import { authoriseWebhook } from '../core/webhookSecurity.js';

/**
 * Public webhook surface.
 *
 * Defences:
 *  - shared-secret header check (spoofed /stop must be impossible);
 *  - update_id de-duplication (Telegram retries on slow 200s);
 *  - fast 200 so Telegram does not retry while we talk to Postgres;
 *  - body size cap.
 */
export function createWebhookServer({
  handler,
  dedupeStore = null,
  secret = '',
  allowInsecure = false,
  logger = console,
  healthChecks = {},
  uptime = () => process.uptime(),
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(uptime()) });
  });

  app.get('/readyz', async (_req, res) => {
    const results = {};
    for (const [name, check] of Object.entries(healthChecks)) {
      try {
        results[name] = (await check()) ? 'ok' : 'fail';
      } catch (error) {
        results[name] = `fail: ${error.message}`;
      }
    }
    const healthy = Object.values(results).every((value) => value === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'not-ready', checks: results });
  });

  app.post('/webhooks/telegram', async (req, res) => {
    try {
      if (!authoriseWebhook({ headers: req.headers, secret, allowInsecure })) {
        logger.warn?.('rejected webhook with missing/invalid secret token');
        res.status(401).json({ ok: false });
        return;
      }

      const update = req.body;
      if (!update || typeof update !== 'object' || Array.isArray(update)) {
        res.status(400).json({ ok: false, error: 'invalid_update' });
        return;
      }

      if (dedupeStore && update.update_id !== undefined) {
        const fresh = await dedupeStore.setIfAbsent(`tg:update:${update.update_id}`, '1', 600);
        if (!fresh) {
          res.json({ ok: true, duplicate: true });
          return;
        }
      }

      // Acknowledge first: processing includes DB writes and a reply call.
      res.json({ ok: true });
    } catch (error) {
      logger.error?.({ err: error.message }, 'webhook pre-processing failed');
      if (!res.headersSent) res.status(500).json({ ok: false });
      return;
    }

    try {
      await handler(req.body);
    } catch (error) {
      logger.error?.({ err: error.message }, 'webhook processing failed');
    }
  });

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return app;
}
