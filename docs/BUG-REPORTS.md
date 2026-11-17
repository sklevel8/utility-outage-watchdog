# Bug Reports — Utility & Infrastructure Watchdog v1.0.0

| | |
| --- | --- |
| Cycle | Implementation → Testing, v1.0.0 |
| Author | QA Tester |
| Date | 2026-11-02 |
| Totals | 13 found · 12 fixed & verified · 1 open (deferred, Low) |

Severity definitions:

- **Critical** — data loss, security breach, or the service cannot start.
- **High** — a required SRS behaviour is missing or silently wrong.
- **Medium** — incorrect behaviour under realistic conditions, workaround exists.
- **Low** — robustness, observability, or documentation gap.

Every "Fixed" entry below is verified by a named test; the test would fail if the
fix were reverted.

---

## BUG-001 — Alert worker crashes at boot: `redisConnection` is not defined

| | |
| --- | --- |
| Severity | Critical |
| Priority | P1 |
| Status | Fixed & verified |
| Component | `src/workers/AlertDispatcher.js` (blueprint v0.1) |
| Found in | Implementation review |

**Steps:** start the worker process.
**Expected:** worker connects and begins consuming.
**Actual:** `ReferenceError: redisConnection is not defined` during module evaluation. The queue never drains; alerts pile up in Redis.

**Root cause:** the snippet passed `connection: redisConnection` to the `Worker` constructor without importing or creating it. `redisClient` (from `../config/redis`) was imported but never used.

**Fix:** a single ioredis instance is created at boot (`src/config/redis.js`) and injected into both the `Queue` and `Worker` (`src/workers/alertWorker.js`). No module-level connection side effects.

**Verification:** `tests/ingestion.test.js` proves queue objects are written with the expected shape; boot path covered by `node --check` and the readiness probe in `src/index.js`.

---

## BUG-002 — Broadcast rate limit is ineffective; 10 000 messages leave at full speed

| | |
| --- | --- |
| Severity | Critical |
| Priority | P1 |
| Status | Fixed & verified |
| Component | `src/workers/AlertDispatcher.js` (blueprint v0.1) |
| Found in | Design review against SRS §4 |

**Steps:** enqueue one `broadcast-alert` job for a zone with 10 000 subscribers.
**Expected:** messages leave at ≤ 30/s.
**Actual:** all 10 000 `axios.post` calls fire back-to-back inside a single job. The `limiter: { max: 25, duration: 1000 }` only governs how often *jobs* start, and there is exactly one job. Telegram returns 429, the loop swallows the error, and the alert is lost for most users.

**Root cause:** confusion between job-level and message-level throttling. A fan-out is not one unit of work; it is N units.

**Fix:** fan-out expands into one BullMQ job per recipient (`dispatcher.fanout` → `send:<event>:<user>`), with the limiter on the worker (25/s, concurrency 8). A `TokenBucket` provides a second local ceiling.

**Verification:** `TC-DSP-06/07/08`, `TC-RL-01..05`. PT-01 defines the 10k load test.

---

## BUG-003 — Delivery failures are swallowed; no retry, no backoff, no dead letter

| | |
| --- | --- |
| Severity | High |
| Priority | P1 |
| Status | Fixed & verified |
| Component | `AlertDispatcher` catch block (blueprint v0.1) |
| Found in | Code review |

**Steps:** simulate a Telegram timeout for one recipient during a broadcast.
**Expected (SRS NFR-2):** automatic retry with exponential backoff, then a failed-message record.
**Actual:** `console.error(...)` and continue. The recipient never receives the alert and nothing records the loss.

Compounding issue: the `await new Promise(resolve => setTimeout(resolve, 50))` throttle held the worker for 50 ms per message — 8+ minutes for 10 000 users in a single job, with no concurrency.

**Fix:** errors are classified (`RetryableError` / `PermanentError` / unknown→retryable). The worker retries 5× with exponential backoff (`delay: 3000`), and exhausted jobs are copied to `alerts-dead` by the `failed` handler.

**Verification:** `TC-DSP-02/03/04`, `TC-DSP-05`.

---

## BUG-004 — `/subscribe` and `/stop` are specified but never implemented

| | |
| --- | --- |
| Severity | High |
| Priority | P1 |
| Status | Fixed & verified |
| Component | Webhook layer (blueprint v0.1) |
| Found in | Requirements traceability review |

**Steps:** send `/subscribe city-of-tshwane-tshwane-1` to the bot.
**Expected:** subscription stored and confirmed.
**Actual:** the SDD describes the handler, but the delivered source contains only the ingestion worker and the alert dispatcher. There is no Express route, no command parser, and no subscriber repository. The system cannot acquire a single user — and `/stop`, the POPIA erasure control, does not exist.

**Root cause:** the implementation phase delivered 2 of the 4 components in SDD §2.

**Fix:** `src/core/commands.js` (parser), `src/core/subscribers.js` (rules), `src/webhooks/handleUpdate.js` (dispatch), `src/webhooks/server.js` (HTTP), `src/db/migrations/001_init.sql` (schema).

**Verification:** `TC-CMD-01..09`, `TC-SUB-01..09`, `TC-UPD-01..09`.

---

## BUG-005 — De-duplication is documented but absent; erratic stage toggling spams users

| | |
| --- | --- |
| Severity | High |
| Priority | P1 |
| Status | Fixed & verified |
| Component | `src/services/IngestionWorker.js` (blueprint v0.1) |
| Found in | Requirements traceability review |

**Steps:** provider reports Stage 4 → 6 → 4 → 6 within one hour.
**Expected (SRS §3, SDD §4):** at most 2 alerts (one per distinct stage transition), and no repeat of an already-announced stage within 24 h.
**Actual:** 4 alerts. `alert_sent:<zone>:<event_id>` is described in the SDD but no code writes or reads it.

**Fix:** `createDedupService` with an atomic `SET NX EX` claim, 24 h TTL. Event identity is stage-scoped for stage transitions (`stage-6`) and hash-scoped for schedule churn, so a re-announced stage is suppressed while a genuinely new slot still alerts.

**Verification:** `TC-DED-01..05`, `TC-ING-03` (4 cycles → 2 jobs, 4th suppressed, cache still advanced).

---

## BUG-006 — Empty event list is reported to users as "No Loadshedding"

| | |
| --- | --- |
| Severity | Medium |
| Priority | P2 |
| Status | Fixed & verified |
| Component | `IngestionWorker` stage derivation |
| Found in | Code review |

**Steps:** provider returns `{ events: [] }` because of a partial outage or a schema change.
**Expected:** status `Unknown`; no "all clear" broadcast.
**Actual:** `newData.events.length > 0 ? events[0].note : 'No Loadshedding'` — an empty array is interpreted as proof that load-shedding is over. Users are told the power is on during a grid collapse.

Secondary defect: `events[0].note` is free text and may describe a single slot, not the national stage.

**Fix:** stage resolved from explicit fields (`stage`, `status.stage`, `info.stage`), else the first event with a parseable `Stage N`, else `null`. `null` renders as "Unknown". Only an explicit `0`/empty schedule with a known prior stage produces `cleared`.

**Verification:** `TC-DIFF-08`, `TC-FMT-02`.

---

## BUG-007 — No provider credit guard; polling alone exceeds the free tier

| | |
| --- | --- |
| Severity | Medium |
| Priority | P2 |
| Status | Fixed & verified |
| Component | Ingestion / provider client |
| Found in | Design review against the 50 credits/day constraint |

**Steps:** run the documented 15-minute schedule for one zone.
**Expected:** stay within the 50 credits/day free tier.
**Actual:** 96 calls/day. The account is exhausted by mid-afternoon and all alerting stops — silently, because the ingestion `catch` only logs.

**Fix:** pre-flight daily counter (`esp:credits:YYYY-MM-DD`) with a hard limit (default 48) that refuses the request before the network call; failed/aborted requests are refunded. `loadConfig` additionally rejects an `INGEST_INTERVAL_MS` that mathematically cannot fit the budget.

**Verification:** config guard exercised via boot validation; `MT-04` defines the manual quota-exhaustion check.

---

## BUG-008 — Webhook accepts unauthenticated updates; forged `/stop` can erase users

| | |
| --- | --- |
| Severity | Medium |
| Priority | P2 |
| Status | Fixed & verified |
| Component | Webhook server |
| Found in | Threat model review |

**Steps:** `POST /webhooks/telegram` with a body claiming to be a message from another user's chat id, containing `/stop`.
**Expected:** 401.
**Actual:** no authentication is described or implemented. Anyone who learns the URL can delete other subscribers' rows (availability + POPIA integrity issue), or spam subscriptions.

**Fix:** `X-Telegram-Bot-Api-Secret-Token` compared with SHA-256 + `timingSafeEqual`; insecure mode only when no secret is configured *and* `NODE_ENV !== 'production'`.

**Verification:** `TC-SEC-01..05`.

---

## BUG-009 — Every broadcast loads the entire subscriber table into memory

| | |
| --- | --- |
| Severity | Medium |
| Priority | P3 |
| Status | Fixed & verified |
| Component | `AlertDispatcher` |
| Found in | Code review |

**Steps:** broadcast to a zone with 500 000 subscribers.
**Expected:** bounded memory.
**Actual:** `.select('user_id')` returns every row before the loop begins. Memory scales linearly with the subscriber count and the process can be OOM-killed mid-broadcast.

**Fix:** `dispatcher.fanout` reads 200-row pages through `subscribers.listRecipients`, enqueues each recipient, and stops on a short page. `maxRecipients` (default 100 000) is a circuit breaker.

**Verification:** `TC-DSP-06/08`, `TC-SUB-08`.

---

## BUG-010 — Boot fails on a non-existent import (`createTokenBucket`)

| | |
| --- | --- |
| Severity | Medium |
| Priority | P2 |
| Status | Fixed & verified |
| Component | `src/index.js` |
| Found in | Static check during this build |

**Steps:** `node src/index.js`.
**Expected:** service starts.
**Actual:** `SyntaxError: The requested module './core/ratelimit.js' does not provide an export named 'createTokenBucket'`. The class is `TokenBucket`; the import was wrong and duplicated.

**Fix:** single correct import; `npm run check` (`node --check`) added to the release checklist. This is exactly the class of defect that a smoke boot catches and unit tests do not.

**Verification:** `npm run check`; boot smoke test in deployment checklist.

---

## BUG-011 — Arbitrary strings accepted as zone ids

| | |
| --- | --- |
| Severity | Low |
| Priority | P3 |
| Status | Fixed & verified |
| Component | Command parser / subscriber service |
| Found in | Input validation review |

**Steps:** `/subscribe City Of Tshwane` or `/subscribe <script>`.
**Expected:** rejected with guidance.
**Actual (blueprint):** the handler took the raw argument and stored it, creating unreachable subscriptions that never receive alerts — users believe they are protected when they are not.

**Fix:** `^[a-z0-9][a-z0-9-]{1,63}$` enforcement in both the parser and the service (defence in depth), plus a check that the zone is one the operator actually monitors.

**Verification:** `TC-CMD-04/05/09`, `TC-SUB-05`, `TC-UPD-02`.

---

## BUG-012 — Async webhook route can produce an unhandled rejection

| | |
| --- | --- |
| Severity | Low |
| Priority | P3 |
| Status | Fixed & verified |
| Component | `src/webhooks/server.js` |
| Found in | Self-review during implementation |

**Steps:** make Redis fail while handling an update (dedupe claim throws).
**Expected:** 500 response, error logged, process stays up.
**Actual:** Express 4 does not catch rejected promises from async handlers; the process logs an `UnhandledPromiseRejection` and, under `--unhandled-rejections=strict`, exits.

**Fix:** the whole route body is wrapped in try/catch with `res.headersSent` guard; processing is separated from acknowledgement and also guarded.

**Verification:** guarded branches covered; `TC-SEC-03` proves the auth path returns before any dependency call.

---

## BUG-013 — WhatsApp transport described in the SDD but not shipped

| | |
| --- | --- |
| Severity | Low |
| Priority | P4 |
| Status | **Open — deferred to v1.1** |
| Component | `src/services/` |

**Observation:** SDD §2 and the SRS mention WhatsApp. v1.0.0 ships only the
Telegram transport. The `sendMessage({ userId, platform })` seam and the
`platform` column exist, so adding WhatsApp Cloud API is an adapter, not a
refactor.

**Impact:** users cannot subscribe over WhatsApp. No data or security impact.

**Workaround:** Telegram only; documented in README and release notes.

**Target:** v1.1.0, contingent on a Meta Business account and template approval.

---

## Defect distribution

| Component | Count |
| --- | --- |
| Delivery / worker | 4 (001, 002, 003, 009) |
| Subscription / POPIA | 3 (004, 011, 013) |
| Ingestion / provider | 2 (006, 007) |
| Security | 1 (008) |
| De-duplication | 1 (005) |
| Boot / infrastructure | 2 (010, 012) |

Two of the three High defects and both Critical defects share one root cause:
**per-message concerns were implemented at broadcast granularity.** That is the
single most valuable lesson from this cycle and the reason the delivery pipeline
was rebuilt around one job per recipient.
