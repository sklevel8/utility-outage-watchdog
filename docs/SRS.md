# Software Requirements Specification — Utility & Infrastructure Watchdog

| | |
| --- | --- |
| Project | #3 — Utility & Infrastructure Watchdog |
| Version | 1.1 (approved baseline) |
| Author | Business Analyst |
| Date | 2026-11-01 |
| Status | Approved — implemented in v1.0.0 |

Changes from v1.0: acceptance criteria added, provider quota requirement made
explicit (FR-1.4), unknown-state handling added (FR-3.3), webhook authentication
promoted from "implied" to SEC-3.

---

## 1. Purpose and scope

A multi-tenant service that watches municipal utility schedules, detects changes,
and pushes localised alerts to subscribers over a messaging platform.

**In scope:** electricity schedule monitoring (load-shedding stage and slot
changes), water/internet status where the provider exposes it, subscription
management over Telegram, change detection, rate-limited dispatch, POPIA
compliance.

**Out of scope for v1.0:** billing, WhatsApp onboarding (transport seam exists,
adapter not shipped), municipal web scraping (provider seam exists), a web UI,
push notifications outside messaging platforms.

## 2. Actors

| Actor | Description |
| --- | --- |
| Subscriber | A person who opted in for one zone via the bot |
| Operator | Runs the service, configures zones and budgets |
| Utility provider | EskomSePush (or a compatible municipal source) |
| Messaging platform | Telegram (WhatsApp planned) |

## 3. Functional requirements

### FR-1 Automated data ingestion

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-1.1 | The system polls configured sources on a schedule, not on user request. | No code path from a webhook to the provider exists. Polling is driven by a single timer. |
| FR-1.2 | Fetched payloads are cached and reused; a cache miss never triggers a per-user provider call. | Two consecutive polls with identical data perform 1 provider call, 0 alerts. |
| FR-1.3 | Ingestion failures for one zone do not stop the others. | One throwing zone still yields results for every other zone. |
| FR-1.4 | The system enforces a local daily provider-credit budget. | Requests beyond `ESP_DAILY_CREDIT_LIMIT` are refused before the network call; boot fails if the poll interval exceeds the budget. |
| FR-1.5 | Only one instance polls at a time. | A Redis advisory lock makes overlapping instances skip the cycle. |

### FR-2 Subscription management

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-2.1 | A user can subscribe to a zone with `/subscribe <zone-id>`. | Valid id creates/updates exactly one row and replies with confirmation. |
| FR-2.2 | Malformed commands are rejected with guidance, never silently ignored. | Missing/extra/invalid args produce a specific explanatory reply; no row is written. |
| FR-2.3 | A user can query their subscription with `/status`. | Reports zone and status, or states that no subscription exists. |
| FR-2.4 | Re-subscribing moves the user to the new zone without duplicating rows. | `UNIQUE (platform, user_id)`; original consent timestamp retained. |
| FR-2.5 | Users can only subscribe to zones the operator monitors. | Unknown zone is refused. |

### FR-3 Change detection

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-3.1 | The system compares the new snapshot with the cached one and classifies the change. | Classes: `initial`, `unchanged`, `stage_change`, `cleared`, `schedule_change`. |
| FR-3.2 | Re-ordered but equivalent provider payloads must not count as changes. | Canonical ordering + hash equality yields `unchanged`. |
| FR-3.3 | Missing data must not be reported as "all clear". | Absent stage is `Unknown`, never stage 0; only an explicit 0/empty schedule produces `cleared`. |
| FR-3.4 | A detected change results in exactly one queued broadcast per event. | Stable queue job id + dedup claim; duplicate polls enqueue nothing. |

### FR-4 Asynchronous dispatch

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-4.1 | Dispatch is decoupled from ingestion. | Ingestion only writes to the queue; delivery happens in a worker. |
| FR-4.2 | Outbound traffic respects platform limits. | Worker limiter ≤ `TELEGRAM_MAX_PER_SECOND` (hard-capped at 30); a local token bucket backs it up. |
| FR-4.3 | Delivery to one recipient is independent of the others. | One job per recipient; a failure cannot abort the broadcast. |
| FR-4.4 | Recipients are read in pages. | Memory use is independent of subscriber count. |

## 4. Security and regulatory requirements

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| SEC-1 | Explicit opt-in, recorded with timestamp and consent text. | `consent_at`/`consent_text` populated on first subscribe only. |
| SEC-2 | `/stop` performs immediate erasure from the active list. | Row is `DELETE`d; no status flag remains; repeat `/stop` is a no-op. |
| SEC-3 | The webhook must be authenticated. | Requests without the configured secret token receive 401. |
| SEC-4 | Duplicate platform updates must not re-run commands. | `update_id` is de-duplicated for 10 minutes. |
| SEC-5 | De-duplication prevents repeat alerts for the same event within 24h. | Second claim of `alert_sent:<zone>:<event>` is refused; cache still advances. |
| SEC-6 | Blocking/removing the bot counts as withdrawal of consent. | `my_chat_member` with `kicked`/`left` deletes the row. |
| SEC-7 | Personal identifiers are not written to logs or analytics. | Logs redact `userId`/`chatId`; `alert_events` stores aggregates only. |

## 5. Non-functional requirements

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-1 | Throughput | Sustain 25 messages/second; a 10 000-recipient broadcast completes without unbounded memory growth |
| NFR-2 | Fault tolerance | Transient failures retried 5× with exponential backoff, then dead-lettered; no silent loss |
| NFR-3 | Availability | Ingestion and webhook process are independently restartable |
| NFR-4 | Observability | Structured logs for every cycle, alert, suppression, and permanent failure |
| NFR-5 | Portability | Node 20.11+; no native build steps |
| NFR-6 | Testability | Domain logic runs offline with no Redis/Postgres/network |

## 6. Constraints and assumptions

- ESP free tier ≈ 50 credits/day; production polling of multiple zones will need
  the paid tier.
- Telegram is the only implemented transport in v1.0.
- Municipal data quality is variable: notes are free text, events can be
  cancelled, payload shapes can change without notice.
- Timezone for all user-facing times: `Africa/Johannesburg`.

## 7. Requirement traceability

| Requirement group | Implementation | Test evidence |
| --- | --- | --- |
| FR-1 | `src/services/ingestion.js`, `src/providers/espClient.js`, `src/config/env.js` | `tests/ingestion.test.js`, TC-ING-* |
| FR-2 | `src/core/commands.js`, `src/core/subscribers.js`, `src/webhooks/handleUpdate.js` | `tests/commands.test.js`, `tests/subscribers.test.js`, `tests/handleUpdate.test.js` |
| FR-3 | `src/core/diff.js` | `tests/diff.test.js` |
| FR-4 | `src/core/dispatcher.js`, `src/workers/alertWorker.js`, `src/core/ratelimit.js` | `tests/dispatcher.test.js`, `tests/ratelimit.test.js` |
| SEC-1/2/6 | `src/core/subscribers.js`, `src/config/database.js` | `tests/subscribers.test.js` |
| SEC-3/4 | `src/core/webhookSecurity.js`, `src/webhooks/server.js` | `tests/webhookSecurity.test.js` |
| SEC-5 | `src/core/dedup.js`, `src/services/ingestion.js` | `tests/dedup.test.js`, `tests/ingestion.test.js` |
| NFR-2 | `src/core/errors.js`, `src/core/dispatcher.js`, `src/workers/alertWorker.js` | `tests/dispatcher.test.js` |
