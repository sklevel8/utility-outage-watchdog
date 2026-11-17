# Maintenance Log — Utility & Infrastructure Watchdog

Append-only. Newest entry at the top. Never edit or delete a past entry; correct
it with a follow-up entry.

| Field | Meaning |
| --- | --- |
| ID | `MNT-YYYYMMDD-nn` |
| Type | Release, Change, Incident, Investigation, Routine |
| Impact | None / Low / Medium / High |
| Status | Open / Monitoring / Closed |

---

## MNT-20261102-01 — v1.0.0 released

| | |
| --- | --- |
| Date | 2026-11-02 |
| Type | Release |
| Impact | None (initial release) |
| Status | Closed |

Deployed v1.0.0 after a PASS QA verdict (86/86 tests, 0 open Critical/High).
Thirteen defects were found and twelve fixed during the cycle; BUG-013
(WhatsApp) is deferred to v1.1.0.

Post-release state:

- Production provider: `fixture` until live credentials and a staging
  environment exist.
- Live checks MT-01/MT-02 and IT-01..04, PT-01 remain outstanding.
- Schema migration `001_init.sql` applied; zones seeded from `WATCH_ZONES`.

**Follow-ups:** schedule the staging validation (MNT-20261102-02), then switch
`ESP_PROVIDER=esp`.

---

## Routine maintenance schedule

| Cadence | Task | Owner | Notes |
| --- | --- | --- | --- |
| Daily | Check `esp:credits:<today>` usage | Operator | Alert at > 80% of limit |
| Daily | Inspect `alerts-dead` queue depth | Operator | Should normally be 0 |
| Weekly | Review `alert_events` for unexpected `change_type` spikes | Engineer | A stage-change storm means provider churn |
| Weekly | Confirm provider endpoint version still matches the adapter | Engineer | RISK-03 |
| Monthly | Rotate `TELEGRAM_WEBHOOK_SECRET` | Operator | Coordinate with `setWebhook` |
| Monthly | Rotate `ESP_API_TOKEN` | Operator | No downtime if done between cycles |
| Monthly | Review retention: purge `alert_events` older than `ALERT_HISTORY_RETENTION_DAYS` | Engineer | Aggregate-only rows |
| Quarterly | Re-run the full test suite and the 10k load test (PT-01) | QA | Record results here |
| Quarterly | Review POPIA consent text and erasure behaviour | Product | Legal sign-off |

## Runbook

### R-01 Provider credits exhausted

**Symptom:** logs contain `QUOTA_EXCEEDED`; no new alerts; `esp:credits:<today>`
equals `ESP_DAILY_CREDIT_LIMIT`.

1. Do not raise the limit blindly — confirm the vendor allowance first.
2. Check for a polling loop: two instances, or an interval below
   `86_400 / limit` seconds.
3. If legitimate, raise `ESP_DAILY_CREDIT_LIMIT` (and the vendor tier) and
   restart.
4. If not, leave the budget capped; alerts resume after midnight. Users keep
   receiving replies from cache; only change detection is paused.
5. Log an entry here with the cause and the corrected interval.

### R-02 Dead-letter queue growing

**Symptom:** `alerts-dead` depth > 0 and rising.

1. Inspect one job: `LLEN bull:alerts-dead:wait` and read a job payload.
2. If `failed_permanent` dominates and reasons mention `403`/`blocked`, those
   users have blocked the bot. Their rows should already have been removed by
   the `my_chat_member` handler; if not, ask the user to `/stop` or purge on
   request.
3. If `429` dominates, `TELEGRAM_MAX_PER_SECOND` is too high for the account's
   actual allowance. Lower it (never above 30) and restart.
4. Replay only after the cause is fixed; replaying into the same condition just
   refills the dead-letter queue.

### R-03 Provider contract change

**Symptom:** `normaliseArea` yields `stage: null` and `events: []` for every
zone; logs show no changes.

1. Capture one raw payload (do not log tokens).
2. Compare against `src/providers/fixtures.js` shape.
3. Update `normaliseArea` and add a fixture; add a test before shipping.
4. Do **not** let the system broadcast "cleared" while the payload is unknown —
   the current design intentionally reports `Unknown`.

### R-04 Suspected double alerts

1. Query Redis for `alert_sent:<zone>:<event>` keys — one per announced event.
2. Check `alert_events` for duplicate `(zone_id, event_id)`; the unique
   constraint should prevent it.
3. Check BullMQ for jobs with unexpected ids. Duplicate sends imply a broken
   `jobId` or a second worker using a different event identity.
4. Preserve the keys before deleting anything.

### R-05 Erasure request outside `/stop`

A data subject may email rather than use the bot.

1. Identify the platform and chat id (operator must have it from the request).
2. `DELETE FROM subscribers WHERE platform = $1 AND user_id = $2;`
3. Confirm 1 row affected and record the request date in this log — **without**
   the identifier.
4. Reply confirming deletion. No soft-delete, no "for audit" copy.

## Monitoring thresholds

| Metric | Warning | Critical | Action |
| --- | --- | --- | --- |
| `esp:credits:<today>` | ≥ 80% of limit | 100% | R-01 |
| `alerts-dead` depth | > 10 | > 100 | R-02 |
| Ingestion cycle duration | > 30 s | > 120 s | Investigate provider latency |
| Webhook 5xx rate | > 1% | > 5% | Check Redis/Postgres readiness |
| Worker failed jobs (5 min) | > 5% | > 20% | Check Telegram status / limiter |
| `/readyz` failures | 1 | 3 consecutive | Page operator |

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Review |
| --- | --- | --- | --- | --- | --- |
| RISK-01 | Free-tier credit exhaustion | High | Medium | Budget guard, interval validation, 80% warning | Monthly |
| RISK-02 | Provider payload drift | Medium | High | Adapter isolation, `Unknown` state, fixture tests | Weekly |
| RISK-03 | ESP endpoint version drift | Medium | High | Pinned base URL, contract check in MT-01 | Before any provider change |
| RISK-04 | Telegram 429 storm during national event | Medium | Medium | 25/s worker limiter, token bucket, 5 retries | Quarterly load test |
| RISK-05 | Misconfigured interval burns quota | Low | High | Boot refuses inconsistent config | Every deploy |
| RISK-06 | Webhook secret leak | Low | High | Secret rotation, 401 on mismatch, no secret in logs | Monthly |

## Change log (implementation-level)

| Date | Change | Reason | Verified by |
| --- | --- | --- | --- |
| 2026-11-01 | SRS v1.1 baseline (acceptance criteria, SEC-3, FR-1.4) | Requirements sign-off | — |
| 2026-11-02 | SDD v1.1 as-built (per-recipient jobs, dedup, budget) | Correct v1.0 design defects | Test plan §5 |
| 2026-11-02 | Implemented `src/core`, providers, workers, webhooks | Release v1.0.0 | 86/86 tests |
| 2026-11-02 | Added `node --check` to release checklist | BUG-010 | `npm run check` |
| 2026-11-02 | Webhook route wrapped in try/catch | BUG-012 | Code review |

## Incident template

```
## MNT-YYYYMMDD-nn — <short title>

| | |
| --- | --- |
| Date | |
| Type | Incident |
| Impact | |
| Status | Open / Monitoring / Closed |
| Detected by | Monitoring / User report / Routine check |

**Timeline** (SAST)
- hh:mm —
- hh:mm —

**Impact:** who was affected, how many, for how long.

**Root cause:**

**Resolution:**

**Preventive action:** (link to a code change or a new test)
```
