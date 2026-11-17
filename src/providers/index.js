import { createEspClient } from './espClient.js';
import { createFixtureClient } from '../adapters/memory.js';
import { buildFixtureSequence } from './fixtures.js';

/**
 * Single seam for the utility provider. Swapping ESP for a municipal scraper
 * (or adding WhatsApp/water providers) means adding a client here, not editing
 * the ingestion worker.
 */
export function createUtilityClient(config, { budgetStore, logger }) {
  if (config.provider === 'fixture') {
    logger.warn?.('ESP_PROVIDER=fixture: serving canned data, no credits consumed');
    return createFixtureClient(buildFixtureSequence());
  }

  return createEspClient({
    token: config.token,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    dailyCreditLimit: config.dailyCreditLimit,
    budgetStore,
    logger,
  });
}
