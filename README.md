# Utility & Infrastructure Watchdog

Real-time load-shedding and municipal outage alerts for South Africa. Polls a utility provider
within a hard credit budget, detects schedule changes, and pushes localised alerts through Telegram
without breaking rate limits or POPIA.

**Live dashboard demo:** https://sklevel8-utility-watchdog.netlify.app
**Stack:** Node.js 20 · Express · BullMQ · Redis · PostgreSQL · Telegram Bot API

---

## Why this exists

Load-shedding schedules change several times a day, and the information people actually need is
narrow: *is my zone affected, and when does it start?* The awkward part is that the useful data sits
behind a metered API. EskomSePush's free tier is roughly **50 credits per day** — and a naive
implementation burns that in a morning, because one zone polled every 15 minutes is already 96 calls.

That constraint shapes the entire design, and it is the reason this is a system rather than a cron
script:

| Constraint | Consequence |
| --- | --- |
| ~50 provider credits/day | Polling must be cached, scheduled, locked and budget-capped. A user action must **never** call the provider. |
| Telegram allows ~30 messages/second | Delivery is one queued job per recipient behind an explicit limiter, not a `for` loop inside a job. |
| POPIA consent and erasure | `/stop` is a hard `DELETE`, consent is recorded, and blocking the bot is treated as withdrawal. |

The boot validator refuses to start if the poll interval and credit budget are inconsistent — a
misconfiguration that would silently exhaust the quota is a startup failure, not a 3 a.m. surprise.

## How it works

```
Telegram users ──► Express webhook (secret auth, update_id dedupe, 256kb cap)
                        │  /subscribe /stop /status
                        ▼
                   Subscriber service ────────────► PostgreSQL
                   (consent, hard delete)             subscribers / zones
                        │
ESP API ──► poll (cron + Redis lock + credit budget) ──► Ingestion service
                                                         │ normalise + hash
                                                         │ diff vs cached snapshot
                                                         │ claim dedup key (24h)
                                                         ▼
                                                  BullMQ "alerts" queue
                                                         │ fanout → 1 job per user
                                                         ▼
                                                  Worker (25 msg/s limiter,
                                                  5 attempts, exponential backoff)
                                                         │
                                                         ├─► Telegram sendMessage
                                                         └─► "alerts-dead" queue
```

**Poll once, serve many.** Ingestion fetches a zone on a schedule, normalises the payload and hashes
it. If the hash matches the cached snapshot, nothing happens — no alerts, no writes. That is what
keeps a 15-minute poll affordable and what prevents the "you have load-shedding" message from
arriving twice.

**Change detection, not polling per user.** A subscriber is a row, not a timer. Every user watching
a zone is served by the same poll, which is both the credit budget and the reason the system scales
to more users at flat provider cost.

**Delivery is queued.** A fanout step turns one schedule change into one job per recipient, and a
worker drains that queue under a 25 msg/s limiter with five attempts and exponential backoff. Failures
land in a dead-letter queue instead of disappearing.

**Consent is data, not a flag.** `/stop` deletes the row. There is deliberately no
`status = 'inactive'` path, because a soft flag is one bad query away from resurrecting a user who
asked to be forgotten.

### Endpoints

| Path | Purpose |
| --- | --- |
| `POST /webhooks/telegram` | Telegram updates (secret header required) |
| `GET /healthz` | Liveness |
| `GET /readyz` | Redis + Postgres readiness |

### Commands the bot understands

| Command | Effect |
| --- | --- |
| `/subscribe <zone>` | Registers the chat against a zone, records consent |
| `/status` | Current schedule for the subscribed zone |
| `/stop` | Deletes the subscription and consent record |

## Features

- Budget-aware polling with a Redis lock so horizontally scaled instances cannot double-poll
- Hash-based change detection: alerts fire on change, not on every fetch
- 24-hour dedup keys to suppress duplicate notifications across poll cycles
- Queue-based fanout with an explicit Telegram rate limiter, retries and a dead-letter queue
- Startup validation that cross-checks `INGEST_INTERVAL_MS` against `ESP_DAILY_CREDIT_LIMIT`
- Offline fixture provider, so the whole pipeline runs with no API token
- 86 tests, all offline — no network, no Redis, no Postgres required
- POPIA-minded storage: chat id only, hard delete, redacted logs

## Run it locally

The fastest path needs no services at all:

```bash
npm install
npm run demo     # subscribe → poll → alert → dedupe → /stop, in memory
npm test         # 86 unit/integration tests
```

Running for real needs Node 20.11+, Redis 6+ and PostgreSQL 13+:

```bash
cp .env.example .env      # ESP_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
npm install
npm run migrate           # schema + seed WATCH_ZONES
npm start
```

Point Telegram at the service:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-host/webhooks/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

| Variable | Default | Notes |
| --- | --- | --- |
| `ESP_PROVIDER` | `fixture` | `fixture` for demos, `esp` for live |
| `ESP_DAILY_CREDIT_LIMIT` | `48` | Headroom under the 50/day free tier |
| `WATCH_ZONES` | — | `id:Display Name,id2:Display Name 2` |
| `INGEST_INTERVAL_MS` | `900000` | Validated against the credit budget at boot |
| `TELEGRAM_MAX_PER_SECOND` | `25` | Hard-capped below 30 |
| `DEDUP_TTL_SECONDS` | `86400` | Spam-suppression window |
| `ALERT_ON_FIRST_SYNC` | `false` | First poll seeds the cache silently |

## The deployed dashboard

Netlify publishes `web/` — a static console over the same concepts: zone lookup, a countdown to the
next slot, the weekly schedule, a credit ledger and a working Telegram command parser that you can
type into (`/subscribe johannesburg`, `/status`, `/stop`). It shows what the bot does without needing
a token or a live provider, and it labels the data as simulated.

## Project layout

```
src/core/        pure domain logic: diff, dedup, rate limiting, commands, formatting, delivery
src/providers/   ESP client plus offline fixtures (the provider seam)
src/services/    ingestion orchestrator, Telegram transport
src/workers/     BullMQ worker wiring
src/webhooks/    Express server and Telegram update handler
src/config/      environment validation, Redis, Postgres, logging
tests/           86 offline tests (node:test)
scripts/         demo and migration helpers
docs/            SRS, SDD, test plan, bug reports, release notes, maintenance log
web/             deployed static dashboard
```

## POPIA notes

- Chat ids are the minimum identifier needed for delivery; no names, phone numbers or addresses.
- `/stop` deletes the row — there is no inactive state to resurrect.
- Blocking or removing the bot is treated as withdrawal of consent.
- Delivery telemetry is aggregate-only, so erasure is complete.
- Logs redact `userId` and `chatId`.

## Documentation

- `docs/SRS.md` — requirements and acceptance criteria
- `docs/SDD.md` — architecture, schema, invariants
- `docs/TEST-PLAN.md`, `docs/BUG-REPORTS.md`, `docs/RELEASE-NOTES.md`, `docs/MAINTENANCE-LOG.md`

## Licence

MIT
