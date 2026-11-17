/**
 * Offline provider fixtures.
 *
 * Three consecutive poll results for the demo zones: a stage change, an
 * escalation, and an erratic revert. The revert is what exercises the
 * de-duplication rule: it must NOT produce a fourth message.
 */

function area(id, name, region, stage, events) {
  return { area: { id, name, region }, stage, events };
}

const TSHWANE_V1 = area('city-of-tshwane-tshwane-1', 'Tshwane 1', 'City of Tshwane', 4, [
  { start: '2026-11-02T18:00:00+02:00', end: '2026-11-02T20:30:00+02:00', note: 'Stage 4' },
  { start: '2026-11-03T02:00:00+02:00', end: '2026-11-03T04:30:00+02:00', note: 'Stage 4' },
]);

const TSHWANE_V2 = area('city-of-tshwane-tshwane-1', 'Tshwane 1', 'City of Tshwane', 6, [
  { start: '2026-11-02T18:00:00+02:00', end: '2026-11-02T20:30:00+02:00', note: 'Stage 6' },
  { start: '2026-11-03T02:00:00+02:00', end: '2026-11-03T04:30:00+02:00', note: 'Stage 6' },
  { start: '2026-11-03T10:00:00+02:00', end: '2026-11-03T12:30:00+02:00', note: 'Stage 6' },
]);

const JHB_V1 = area('eskom-direct-city-of-johannesburg-1', 'Johannesburg 1', 'City of Johannesburg', 4, [
  { start: '2026-11-02T20:00:00+02:00', end: '2026-11-02T22:30:00+02:00', note: 'Stage 4' },
]);

const JHB_CLEARED = area('eskom-direct-city-of-johannesburg-1', 'Johannesburg 1', 'City of Johannesburg', 0, []);

export function buildFixtureSequence() {
  return {
    // 4 -> 6 -> 4 -> 6: the second 6 must be suppressed by the 24h dedup key.
    'city-of-tshwane-tshwane-1': [TSHWANE_V1, TSHWANE_V2, TSHWANE_V1, TSHWANE_V2],
    'eskom-direct-city-of-johannesburg-1': [JHB_V1, JHB_CLEARED],
  };
}
