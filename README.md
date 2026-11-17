# Utility & Infrastructure Watchdog

Real-time load-shedding and municipal outage alerting for South Africa. Polls a
utility provider on a budget, detects schedule changes, and pushes localised
alerts through Telegram without violating rate limits or POPIA.

**Status:** v1.0.0 — release candidate, tested. See [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md).

---

## Why the architecture looks like this

Two hard constraints drive every decision:

| Constraint | Consequence |
| --- | --- |
| EskomSePush free tier is ~50 credits/day | Polling must be cached, scheduled, locked, and budget-capped. User actions must never call the provider. |
| Telegram allows ~30 messages/second | Delivery must be one queued job per recipient with an explicit limiter, not a `for` loop inside a job. |
| POPIA consent + erasure | `/stop` is a SQL `DELETE`. Consent is recorded. Blocking the bot also purges the row. |

A 15-minute poll of one zone is 96 calls/day, which already exceeds the free
tier. The boot validator refuses to start if `INGEST_INTERVAL_MS` and
`ESP_DAILY_CREDIT_LIMIT` are inconsistent.

## Architecture

```
                       ┌──────────────────────────────┐
  Telegram users ─────►│ Express webhook (secret auth, │
                       │ update_id dedupe, 256kb cap)  │
                       └──────────────┬───────────────┘
                                      │ /subscribe /stop /status
                                      ▼
                       ┌──────────────────────────────┐
                       │ Subscriber service            │──► PostgreSQL
                       │ (consent, hard delete)        │    subscribers / zones
                       └──────────────────────────────┘

  ESP API ◄── poll (cron + Redis lock + credit budget) ── Ingestion service
                                                          │ normalise + hash
                                                          │ diff vs cached snapshot
                                                          │ claim dedup key (24h)
                                                          ▼
                                                   BullMQ "alerts" queue
                                                          │ fanout → 1 job per user
                                                          ▼
                                                   Worker (25 msg/s limiter,
                                                   5 attempts, exp. backoff)
                                                          │
                                                          ├─► Telegram sendMessage
                                                          └─► "alerts-dead" queue
```

## Quick start (no services required)

```bash
npm run demo     # offline end-to-end: subscribe → poll → alert → dedupe → /stop
npm test         # 86 unit/integration tests, no network, no Redis, no Postgres
```

The demo uses in-memory adapters but the **same** core modules the production
workers call.

## Running for real

Requirements: Node 20.11+, Redis 6+, PostgreSQL 13+.

```bash
cp .env.example .env          # fill in ESP_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
npm install
npm run migrate               # schema + seed WATCH_ZONES
npm start
```

Point Telegram at the service:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-host/webhooks/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Endpoints:

| Path | Purpose |
| --- | --- |
| `POST /webhooks/telegram` | Telegram updates (secret header required) |
| `GET /healthz` | Liveness |
| `GET /readyz` | Redis + Postgres readiness |

## Configuration

All variables and defaults are documented in [.env.example](.env.example). The
ones that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `ESP_PROVIDER` | `fixture` | `fixture` for demos, `esp` for live |
| `ESP_DAILY_CREDIT_LIMIT` | `48` | Leaves headroom under the 50/day free tier |
| `WATCH_ZONES` | — | `id:Display Name,id2:Display Name 2` |
| `INGEST_INTERVAL_MS` | `900000` | Validated against the credit budget at boot |
| `TELEGRAM_MAX_PER_SECOND` | `25` | Hard-capped at 30 |
| `DEDUP_TTL_SECONDS` | `86400` | Spam-prevention window |
| `ALERT_ON_FIRST_SYNC` | `false` | First poll seeds the cache silently |

## Project layout

```
src/core/        pure, dependency-free domain logic (diff, dedup, rate limit,
                 commands, formatting, subscriber rules, delivery pipeline)
src/providers/   ESP client + offline fixtures (provider seam)
src/services/    ingestion orchestrator, Telegram transport
src/workers/     BullMQ worker wiring
src/webhooks/    Express server + Telegram update handler
src/config/      env validation, Redis, Postgres, logging
tests/           86 tests (node:test), all offline
scripts/         demo.js, migrate.js
docs/            SRS, SDD, test plan, bug reports, release notes, maintenance log
```

## POPIA notes

- Chat ids are the minimum identifier needed for delivery; no names, phone
  numbers, or addresses are stored.
- `/stop` deletes the row. There is no `status = 'inactive'` path to
  accidentally resurrect a user.
- Blocking/removing the bot is also treated as withdrawal of consent.
- Delivery telemetry is aggregate-only (`alert_events`), so erasure is complete.
- Logs redact `userId`/`chatId`.

## Documentation

- [SRS](docs/SRS.md) — requirements, acceptance criteria
- [SDD](docs/SDD.md) — architecture, schema, invariants
- [Test Plan & Results](docs/TEST-PLAN.md)
- [Bug Reports](docs/BUG-REPORTS.md)
- [Release Notes](docs/RELEASE-NOTES.md)
- [Maintenance Log](docs/MAINTENANCE-LOG.md)
