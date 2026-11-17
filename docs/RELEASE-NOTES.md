# Release Notes — Utility & Infrastructure Watchdog v1.0.0

| | |
| --- | --- |
| Release | 1.0.0 — first production candidate |
| Date | 2026-11-02 |
| Author | Project Manager / Release Manager |
| Classification | Minor: new system |
| QA verdict | PASS — 86/86 tests, 0 open Critical/High |
| Commit/tag | `v1.0.0` (tag the commit after merging the release branch) |

---

## 1. Summary

First end-to-end release of the load-shedding and municipal outage alerting
service. Ingestion, change detection, de-duplication, subscription management,
and rate-limited Telegram delivery are implemented and tested.

This release is **feature-complete against SRS v1.1** except for WhatsApp
delivery (BUG-013, deferred) and the manual/integration checks listed as MT-01,
MT-02, IT-01..04 and PT-01, which require a staging environment and live
credentials.

## 2. What's new

### Ingestion and change detection
- Scheduled polling with a Redis advisory lock, so overlapping instances cannot
  double-poll.
- Normalised snapshots with canonical event ordering; provider re-ordering is
  never mistaken for a schedule change.
- Five change classes: `initial`, `unchanged`, `stage_change`, `cleared`,
  `schedule_change`.
- Explicit "unknown" state — a partial provider response can no longer produce a
  false "power is back" broadcast.

### Subscription management (Telegram)
- `/start`, `/help`, `/subscribe <zone-id>`, `/status`, `/stop` (and
  `/unsubscribe` alias).
- Explicit opt-in recorded with consent text and timestamp.
- `/stop` is a hard `DELETE`; repeat calls are safe.
- Blocking or removing the bot also purges the subscription.

### Delivery
- One queue job per recipient; worker limiter at 25 msg/s (Telegram ceiling 30).
- Local token bucket as a second ceiling.
- 5 retries with exponential backoff, then dead-letter (`alerts-dead`).
- Deterministic job ids make double-sends impossible across retries.

### Operations
- `/healthz` and `/readyz` (Redis + Postgres).
- Structured JSON logs with `userId`, `chatId` and tokens redacted.
- Graceful shutdown on SIGINT/SIGTERM.
- Boot-time validation of configuration, including a mathematical check that the
  poll interval fits the daily credit budget.

### Compliance (POPIA)
- Data minimisation: chat id only, no names, phone numbers, or addresses.
- Erasure is a real delete, with no soft-delete path in the repository.
- Delivery telemetry stores aggregates only, so erasure is complete.
- Webhook authentication prevents forged `/stop` updates.

## 3. Defects fixed since the implementation draft

| ID | Severity | Summary |
| --- | --- | --- |
| BUG-001 | Critical | Worker crashed at boot (`redisConnection` undefined) |
| BUG-002 | Critical | Broadcast rate limit ineffective; unthrottled burst |
| BUG-003 | High | Failures swallowed; no retry/backoff/dead-letter |
| BUG-004 | High | `/subscribe` and `/stop` not implemented |
| BUG-005 | High | De-duplication specified but absent; repeat alerts |
| BUG-006 | Medium | Empty event list reported as "No Loadshedding" |
| BUG-007 | Medium | No credit guard; 96 calls/day against a 50/day tier |
| BUG-008 | Medium | Unauthenticated webhook; forged erasure possible |
| BUG-009 | Medium | Whole subscriber table loaded per broadcast |
| BUG-010 | Medium | Non-existent import broke boot |
| BUG-011 | Low | Arbitrary strings accepted as zone ids |
| BUG-012 | Low | Async webhook route could crash the process |

Details and verification evidence: [BUG-REPORTS.md](BUG-REPORTS.md).

## 4. Known issues and limitations

| Ref | Item | Impact | Target |
| --- | --- | --- | --- |
| BUG-013 | WhatsApp transport not shipped | Telegram only | v1.1.0 |
| RISK-01 | Free-tier credits (≈50/day) limit how many zones can be watched | 1–2 zones at 15-min polling | Operator decision |
| RISK-03 | ESP API version beyond v2.0 unverified; base URL pinned | Possible contract drift | Validate in MT-01 |
| — | One active zone per user | Product decision, not a defect | Under review |
| — | Offset pagination in fan-out | Fine to ~10⁵ recipients per zone | v1.2 if needed |
| — | MT-01, MT-02, IT-01..04, PT-01 not executed | Live behaviour unproven until staging exists | Before public launch |

## 5. Upgrade / deployment

```bash
# 1. Install and configure
npm ci
cp .env.example .env         # set ESP_PROVIDER=esp, tokens, secrets, WATCH_ZONES

# 2. Apply schema and seed zones
npm run migrate

# 3. Verify
npm run check
npm test                     # expect 86 passing

# 4. Start
npm start
```

Post-deploy checks:

1. `GET /healthz` → `{"status":"ok"}`.
2. `GET /readyz` → `redis: ok`, `postgres: ok`.
3. Register the webhook with the same `secret_token` value as
   `TELEGRAM_WEBHOOK_SECRET`.
4. Send `/help` from a phone; expect a reply within 2 s.
5. Watch the first ingestion cycle log: `ingestion cycle complete`.
6. Confirm `esp:credits:<today>` is `1`, not `N × zones`.

**Schema changes:** additive only (`001_init.sql`). No destructive migration.

## 6. Configuration changes

New in this release (all documented in `.env.example`):

| Variable | Required | Notes |
| --- | --- | --- |
| `ESP_PROVIDER` | Yes | `esp` for live, `fixture` for demos |
| `ESP_DAILY_CREDIT_LIMIT` | Recommended | Default 48; boot validates interval against it |
| `TELEGRAM_WEBHOOK_SECRET` | Yes in production | Boot fails without it |
| `TELEGRAM_MAX_PER_SECOND` | No | Default 25; values above 30 refuse to boot |
| `DEDUP_TTL_SECONDS` | No | Default 86 400 |
| `ALERT_ON_FIRST_SYNC` | No | Default `false` (seed silently) |

## 7. Rollback

1. Stop the service (SIGTERM drains the worker).
2. Redeploy the previous tag; the schema is forward-compatible (additive only).
3. Redis keys are namespaced and expire on their own; no manual cleanup needed.
4. If the rollback is due to provider quota exhaustion, set
   `ESP_PROVIDER=fixture` to keep the webhook alive while investigating.

Rollback is non-destructive to subscriber data. Do **not** truncate
`subscribers` as part of a rollback — that would violate erasure integrity and
lose live consent records.

## 8. Verification evidence

| Check | Result |
| --- | --- |
| `npm test` | 86 passed, 0 failed, ~2.0 s |
| Line coverage (tested modules) | 97.18% |
| Branch coverage | 82.62% |
| Open Critical / High defects | 0 |
| Boot smoke (`node --check`, readiness) | Pass |
| Offline demo (`npm run demo`) | 4 poll cycles, 2 alerts, 1 suppression, 1 erasure |

## 9. Next release (v1.1.0) candidates

1. WhatsApp Cloud API adapter behind the existing transport seam (BUG-013).
2. Live staging validation: MT-01/MT-02, IT-01..04, PT-01.
3. Provider contract test against the currently advertised ESP endpoint version.
4. Per-zone subscriptions (join table) if users ask for more than one zone.
5. Alert-history retention job (`ALERT_HISTORY_RETENTION_DAYS`).
6. Quota-burn alert at 80% of `ESP_DAILY_CREDIT_LIMIT`.
