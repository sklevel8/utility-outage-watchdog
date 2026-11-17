import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAlert,
  formatStatus,
  formatSubscribeError,
  formatUnsubscribed,
  truncate,
  TELEGRAM_MAX_LENGTH,
} from '../src/core/format.js';

test('a stage escalation names both stages', () => {
  const text = formatAlert({
    areaName: 'Tshwane 1',
    previousStage: 4,
    currentStage: 6,
    changeType: 'stage_change',
    events: [
      { start: '2026-11-02T16:00:00.000Z', end: '2026-11-02T18:30:00.000Z', note: 'Stage 6' },
    ],
  });

  assert.match(text, /Stage 4 → Stage 6/);
  assert.match(text, /Tshwane 1/);
  assert.match(text, /\/stop/);
  assert.match(text, /18:00/); // 16:00Z rendered in Africa/Johannesburg, not UTC
  assert.match(text, /20:30/);
});

test('a cleared alert says the power is back instead of "Stage 0"', () => {
  const text = formatAlert({
    areaName: 'Johannesburg 1',
    previousStage: 4,
    currentStage: 0,
    changeType: 'cleared',
    events: [],
  });

  assert.match(text, /suspended/i);
  assert.doesNotMatch(text, /Stage 0/);
});

test('long provider notes are truncated at the Telegram limit', () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    note: `Stage 6 outage ${index} ${'x'.repeat(2_000)}`,
  }));

  const text = formatAlert({ areaName: 'Long Zone', currentStage: 6, changeType: 'schedule_change', events });

  assert.ok(text.length <= TELEGRAM_MAX_LENGTH);
  assert.ok(text.endsWith('…'));
  assert.ok(text.split('•').length - 1 <= 3, 'never more than three slots are listed');
});

test('truncate leaves short strings alone', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 10), 'hello wor…');
});

test('the unsubscribe confirmation states that data was deleted', () => {
  const text = formatUnsubscribed();
  assert.match(text, /permanently deleted/i);
});

test('subscribe errors are actionable, not stack traces', () => {
  assert.match(formatSubscribeError('MISSING_ZONE'), /\/subscribe city-of-tshwane/);
  assert.match(formatSubscribeError('INVALID_ZONE', 'bad id'), /bad id/);
  assert.match(formatSubscribeError('UNKNOWN_ZONE'), /not being monitored/);
  assert.doesNotMatch(formatSubscribeError('SOMETHING_NEW'), /undefined/);
});

test('status reflects the subscription or its absence', () => {
  assert.match(formatStatus(null), /not subscribed/);
  const text = formatStatus({ zoneId: 'zone-a', status: 'active', consentAt: '2026-11-01T00:00:00Z' });
  assert.match(text, /zone-a/);
  assert.match(text, /active/);
});

test('event timestamps fall back to the raw value when unparseable', () => {
  const text = formatAlert({
    areaName: 'Zone',
    currentStage: 4,
    changeType: 'schedule_change',
    events: [{ start: 'not-a-date', end: null, note: 'Stage 4' }],
  });
  assert.match(text, /not-a-date/);
});
