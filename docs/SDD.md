# System Design Document — Utility & Infrastructure Watchdog

| | |
| --- | --- |
| Project | #3 — Utility & Infrastructure Watchdog |
| Version | 1.1 (as-built) |
| Author | System Architect |
| Date | 2026-11-02 |
| Status | Implemented |

This is the as-built design. Section 9 lists where it deliberately differs from
the v1.0 blueprint and why.

---

## 1. Architectural overview

Modular, event-driven Node.js (ESM). Ingestion and delivery are separate
process roles that share Redis and PostgreSQL but never call each other
directly.

```
poll timer ──► ingestion ──► queue ──► worker ──► provider
   │              │                       │
   └── Redis lock │                       └── Redis token bucket
                  ├── Redis snapshot cache
                  └── Redis dedup key (SET NX EX)

webhook ──► express ──► command handler ──► PostgreSQL
```

Key invariant: **no user-triggered code path calls the utility provider.** Users
read cached state only, so a viral message cannot burn the daily quota.

## 2. Components

| Component | Responsibility | File |
| --- | --- | --- |
| Provider client | HTTP, credit budget, retry/backoff, error taxonomy | `src/providers/espClient.js` |
| Ingestion | Normalise, diff, dedupe, enqueue, cache | `src/services/ingestion.js` |
| Diff engine | Pure snapshot hashing and change classification | `src/core/diff.js` |
| Dedup | Atomic claim per (zone, event), 24h TTL | `src/core/dedup.js` |
| Dispatcher | Paginated fan-out, per-message delivery rules | `src/core/dispatcher.js` |
| Worker | BullMQ consumer, 25 msg/s limiter, dead-letter | `src/workers/alertWorker.js` |
| Webhook server | Auth, update dedupe, health | `src/webhooks/server.js` |
| Command handler | Telegram updates → subscriber service | `src/webhooks/handleUpdate.js` |
| Subscriber service | Opt-in, erasure, paging | `src/core/subscribers.js` |
| Transport | Telegram send + error mapping | `src/services/telegram.js` |

### Why the domain lives in `src/core`

Diffing, de-duplication, paging and rate limiting are pure or
dependency-injected. That is what allows 86 tests to run with no Redis, no
Postgres, no network, and it keeps the POPIA rules (hard delete) in a module
small enough to audit.

## 3. Data model

```sql
zones(zone_id PK, suburb_name, provider, current_status_hash,
      current_stage, last_updated, created_at)

subscribers(id PK, platform, user_id, zone_id FK, status, consent_at,
            consent_text, created_at, updated_at,
            UNIQUE (platform, user_id))
  INDEX (zone_id, user_id) WHERE status = 'active'

alert_events(id PK, zone_id, event_id, change_type, previous_stage,
             current_stage, message_hash, recipients, sent, failed, created_at,
             UNIQUE (zone_id, event_id))
```

**POPIA design decisions**

- `subscribers` stores a chat id, not a phone number or name.
- `alert_events` stores **no** recipient identifier: erasure is therefore
  complete after the `DELETE`, and broadcast telemetry still works.
- There is no `updateStatus()` helper in the repository, so a soft delete
  cannot be reintroduced by accident.

### Redis keys

| Key | Type | TTL | Purpose |
| --- | --- | --- | --- |
| `zone:snapshot:<zone_id>` | string (JSON) | 7d | Last normalised snapshot |
| `alert_sent:<zone_id>:<event_id>` | string | 24h | Spam-prevention claim |
| `esp:credits:YYYY-MM-DD` | counter | 25h | Daily provider budget |
| `lock:ingestion` | string | 0.9 × interval | Single-poller advisory lock |
| `tg:update:<update_id>` | string | 10m | Webhook replay protection |

## 4. Change detection algorithm

1. `normaliseArea()` maps the provider payload to
   `{ areaId, areaName, region, stage, events[] }`.
2. Events are canonicalised (trimmed, parsed stage, sorted by start/end/note) so
   provider re-ordering is not a change.
3. `hash = SHA-256(canonical JSON)`; `fetchedAt` is excluded, otherwise every
   poll would "change".
4. `diffSnapshots(previous, next)` classifies the change.

Event identity for de-duplication:

| changeType | eventId |
| --- | --- |
| `stage_change` | `stage-<n>` |
| `cleared` | `stage-0` |
| `schedule_change` | snapshot hash |

Using the stage (not the hash) for stage transitions means 4 → 6 → 4 → 6 within
24 hours produces **two** messages, not four. That is the spam-prevention rule
in practice.

Ordering guarantee: the cache is advanced only **after** the queue accepts the
job. If Redis/BullMQ is unavailable the snapshot is not advanced, so the next
poll re-detects the change instead of losing it.

## 5. Delivery pipeline

```
fanout job  → page subscribers (200/query) → one "send" job per recipient
send job    → token bucket → transport → success | permanent | retry
```

- `limiter: { max: 25, duration: 1000 }` on the worker, with `concurrency: 8`.
- `attempts: 5`, `backoff: exponential, delay: 3000`.
- Errors are classified in `src/core/errors.js`:
  - `RetryableError` (timeout, 429, 5xx) → throw, queue retries.
  - `PermanentError` (blocked bot, bad chat id) → record, do not retry.
  - Unknown error → treated as retryable (a lost alert is worse than a retry).
- Exhausted jobs are copied to `alerts-dead` by the `failed` handler.
- Job ids are deterministic (`send:<event>:<user>`), so a retried fan-out cannot
  double-send.

## 6. Webhook security

1. Shared-secret header `X-Telegram-Bot-Api-Secret-Token` compared with
   `crypto.timingSafeEqual` over SHA-256 digests.
2. `update_id` claimed in Redis (10 min) so platform retries do not replay a
   command.
3. Body capped at 256 kB; unknown routes return JSON 404.
4. Acknowledgement is sent before processing so a slow database does not cause
   platform retries.
5. Insecure mode (no secret) is only possible when no secret is configured and
   `NODE_ENV !== 'production'`.

## 7. Operational behaviour

| Concern | Design |
| --- | --- |
| Quota safety | Pre-flight budget counter, plus a boot check that rejects an interval which would exceed the budget |
| Single poller | `SET lock:ingestion <id> EX <0.9×interval> NX`; a crashed holder self-releases |
| Graceful shutdown | SIGINT/SIGTERM → stop timer, close HTTP server, drain worker, quit Redis, destroy pool |
| Readiness | `/readyz` pings Redis and Postgres; 503 when either fails |
| Logging | pino, structured, `userId`/`chatId`/tokens redacted |

## 8. Known design limits

- One active zone per user (product decision; the schema allows many-to-many
  later via a join table).
- Offset pagination in fan-out: sufficient at 10⁴–10⁵ rows; keyset pagination is
  the upgrade path.
- The provider adapter is pinned to the ESP v2.0 base URL. Endpoint versions
  beyond that must be validated against the vendor before switching
  (RISK-03).
- WhatsApp is a transport interface only; no adapter is shipped in v1.0.

## 9. Changes from blueprint v1.0

| # | Blueprint | As-built | Reason |
| --- | --- | --- | --- |
| 1 | One queue job per broadcast, limiter on the job | One job per recipient, limiter on the worker | A limiter only throttles job *starts*; the broadcast loop inside one job was unthrottled |
| 2 | `await sleep(50)` inside the loop | Removed; queue limiter + token bucket | Blocking sleeps serialize the worker and still miss the exact rate |
| 3 | Retry left as "optional dead-letter" | 5 attempts, exponential backoff, dead-letter queue | Direct SRS NFR-2 requirement |
| 4 | `redisConnection` referenced, never imported | Shared ioredis instance injected | The snippet threw `ReferenceError` at boot |
| 5 | `/subscribe` and `/stop` described, unimplemented | `src/core/commands.js` + `handleUpdate.js` | POPIA compliance was not implementable as specified |
| 6 | `events[0].note` treated as current stage | Stage resolved from explicit fields, else events, else `null` | Empty event list is not proof of "no load-shedding" |
| 7 | No credit guard | Daily budget + interval validator | 15-minute polling = 96 calls/day vs 50 free |
| 8 | No webhook authentication | Constant-time secret check | Forged `/stop` could erase other users |
| 9 | Full subscriber list loaded per broadcast | 200-row pages | Memory bound independent of list size |
| 10 | No dedup implementation | Atomic Redis claim, stage-scoped ids | SRS §3 spam prevention |
