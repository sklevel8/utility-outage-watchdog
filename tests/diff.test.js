import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, extractStage, normaliseArea } from '../src/core/diff.js';

const payload = (stage, events) => ({ area: { id: 'z1', name: 'Zone 1' }, stage, events });
const ev = (start, end, note) => ({ start, end, note });

test('extractStage reads the stage from free text', () => {
  assert.equal(extractStage('Stage 6'), 6);
  assert.equal(extractStage('Loadshedding stage 12'), 12);
  assert.equal(extractStage('No stage here'), null);
  assert.equal(extractStage(''), null);
  assert.equal(extractStage(null), null);
});

test('snapshot hash ignores event order and fetch timestamp', () => {
  const a = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4'), ev('2026-11-03T02:00', '2026-11-03T04:30', 'Stage 4')]), {
    fetchedAt: '2026-11-01T00:00:00.000Z',
  });
  const b = normaliseArea(payload(4, [ev('2026-11-03T02:00', '2026-11-03T04:30', 'Stage 4'), ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]), {
    fetchedAt: '2026-11-01T06:00:00.000Z',
  });
  assert.equal(a.hash, b.hash);
});

test('snapshot hash changes when an event changes', () => {
  const a = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const b = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T22:30', 'Stage 4')]));
  assert.notEqual(a.hash, b.hash);
});

test('first sync is reported as initial, not as a stage change', () => {
  const next = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const diff = diffSnapshots(null, next);

  assert.equal(diff.changed, true);
  assert.equal(diff.changeType, 'initial');
  assert.equal(diff.previousStage, null);
  assert.equal(diff.currentStage, 4);
  assert.equal(diff.eventId, next.hash);
});

test('identical snapshots produce no diff', () => {
  const previous = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const next = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const diff = diffSnapshots(previous, next);

  assert.equal(diff.changed, false);
  assert.equal(diff.changeType, 'unchanged');
  assert.equal(diff.eventId, null);
});

test('Stage 4 -> Stage 6 is a stage_change with a stage-scoped event id', () => {
  const previous = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const next = normaliseArea(payload(6, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 6')]));
  const diff = diffSnapshots(previous, next);

  assert.equal(diff.changed, true);
  assert.equal(diff.changeType, 'stage_change');
  assert.equal(diff.previousStage, 4);
  assert.equal(diff.currentStage, 6);
  assert.equal(diff.eventId, 'stage-6');
});

test('a drop to stage 0 with no events is "cleared"', () => {
  const previous = normaliseArea(payload(6, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 6')]));
  const next = normaliseArea(payload(0, []));
  const diff = diffSnapshots(previous, next);

  assert.equal(diff.changed, true);
  assert.equal(diff.changeType, 'cleared');
  assert.equal(diff.currentStage, 0);
  assert.equal(diff.eventId, 'stage-0');
});

test('same stage with a moved slot is a schedule_change keyed by hash', () => {
  const previous = normaliseArea(payload(4, [ev('2026-11-02T18:00', '2026-11-02T20:30', 'Stage 4')]));
  const next = normaliseArea(payload(4, [ev('2026-11-02T19:00', '2026-11-02T21:30', 'Stage 4')]));
  const diff = diffSnapshots(previous, next);

  assert.equal(diff.changeType, 'schedule_change');
  assert.equal(diff.eventId, next.hash);
  assert.equal(diff.addedEvents.length, 1);
  assert.equal(diff.removedEvents.length, 1);
});

test('normaliseArea tolerates a payload with no events array', () => {
  const snapshot = normaliseArea({ area: { id: 'z9', name: 'Nine' } });
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.stage, null);
  assert.equal(snapshot.hash.length, 64);
});

test('normaliseArea rejects non-object payloads', () => {
  assert.throws(() => normaliseArea(null), TypeError);
  assert.throws(() => normaliseArea('nope'), TypeError);
});
