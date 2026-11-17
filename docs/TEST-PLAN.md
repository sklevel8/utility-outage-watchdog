# Test Plan & Test Report — Utility & Infrastructure Watchdog v1.0.0

| | |
| --- | --- |
| Project | #3 — Utility & Infrastructure Watchdog |
| Version under test | 1.0.0 |
| Author | QA Tester |
| Date | 2026-11-02 |
| Environment | Windows 11, Node v24.19.0, npm 11.17.0 |
| Verdict | **PASS** — 86/86 automated tests, 0 open critical/high defects |

---

## 1. Objectives

1. Verify every SRS requirement (FR-1..4, SEC-1..7, NFR-1..6) has executable
   evidence.
2. Prove the two highest-risk behaviours: **no double alerts** for the same
   event, and **no unthrottled burst** to the messaging provider.
3. Prove POPIA erasure is a real delete.
4. Establish a regression suite that runs with no infrastructure.

## 2. Scope

**In scope:** change detection, de-duplication, command parsing, subscriber
lifecycle, delivery error handling, rate limiting, webhook authentication,
message rendering, ingestion orchestration.

**Out of scope for this cycle (and why):**

| Area | Reason | Coverage |
| --- | --- | --- |
| Live ESP API | Requires a paid/registered token; calls consume credits | Mocked via fixtures; manual smoke test defined as MT-01 |
| Live Telegram delivery | Requires bot token + public webhook URL | Transport error mapping unit-tested with simulated responses; MT-02 |
| Redis/BullMQ integration | Requires running Redis | Wired but not exercised in CI; IT-01/IT-02 defined |
| PostgreSQL queries | Requires running Postgres | Repository is thin; IT-03 defined |
| Load test at 10 000 recipients | No staging environment in this cycle | PT-01 defined with the exact command and pass criteria |

Untested paths are declared, not assumed. That distinction matters: a green
suite that silently skips the risky parts is worse than a red one.

## 3. Test approach

| Level | Tooling | What it proves |
| --- | --- | --- |
| Unit | `node:test` | Pure logic: diff, dedup, rate limit, commands, formatting, auth |
| Component | `node:test` + in-memory adapters | Subscriber rules, dispatcher, ingestion end-to-end |
| Integration | Manual / compose | Redis, Postgres, BullMQ, provider |
| Performance | `autocannon` or a scripted enqueue | Throughput and memory bound |
| Security | Manual review + unit tests | Webhook auth, log redaction, SQL injection surface |

No mocking framework is used. Adapters are injected, so tests exercise the same
seams production uses.

## 4. Entry and exit criteria

**Entry:** code builds (`node --check`), schema migration applies, `.env.example`
documents every variable.

**Exit:**
- 100% of P1/P2 test cases executed.
- 0 open Critical or High defects.
- Line coverage ≥ 90% on `src/core` and `src/services`.
- Every SRS requirement mapped to at least one passing test.

**Actual:** all met. 97.2% line coverage on tested modules; 13 defects found,
12 fixed and verified, 1 deferred and documented
([BUG-REPORTS.md](BUG-REPORTS.md)).

## 5. Test cases and results

### 5.1 Change detection — `tests/diff.test.js` (10 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-DIFF-01 | Stage extracted from free text | 6 / 12 / null | Pass |
| TC-DIFF-02 | Event order varies between polls | Identical hash | Pass |
| TC-DIFF-03 | Only `fetchedAt` differs | Identical hash | Pass |
| TC-DIFF-04 | One event end time changes | Different hash | Pass |
| TC-DIFF-05 | First poll | `initial`, eventId = hash | Pass |
| TC-DIFF-06 | Identical payloads | `unchanged`, eventId null | Pass |
| TC-DIFF-07 | Stage 4 → 6 | `stage_change`, `stage-6` | Pass |
| TC-DIFF-08 | Stage 6 → 0, no events | `cleared`, `stage-0` | Pass |
| TC-DIFF-09 | Same stage, slot moved | `schedule_change` keyed by hash | Pass |
| TC-DIFF-10 | Payload without events / non-object | Empty events, `TypeError` | Pass |

### 5.2 Commands — `tests/commands.test.js` (9 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-CMD-01 | `/subscribe zone-a` | Parsed with zoneId | Pass |
| TC-CMD-02 | `/subscribe@Bot zone-a` | Group-chat suffix stripped | Pass |
| TC-CMD-03 | `/subscribe` | `MISSING_ZONE` | Pass |
| TC-CMD-04 | `/subscribe city of tshwane` | `TOO_MANY_ARGUMENTS`, no truncation | Pass |
| TC-CMD-05 | `/subscribe BAD_ZONE!` | `INVALID_ZONE` | Pass |
| TC-CMD-06 | `/stop`, `/unsubscribe`, `/stop.` | All map to `stop` | Pass |
| TC-CMD-07 | `/help`, `/status`, `/start`, `/start payload` | Recognised | Pass |
| TC-CMD-08 | Whitespace / plain text | `empty` / `unknown` | Pass |
| TC-CMD-09 | Zone id format boundaries | 1 char and 65 chars rejected | Pass |

### 5.3 De-duplication — `tests/dedup.test.js` (6 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-DED-01 | Key format | `alert_sent:<zone>:<event>` | Pass |
| TC-DED-02 | Unsafe key parts | `TypeError` | Pass |
| TC-DED-03 | Second claim inside 24h | Refused | Pass |
| TC-DED-04 | Same event, different zones | Both allowed | Pass |
| TC-DED-05 | Claim after TTL | Allowed again | Pass |
| TC-DED-06 | Store without `setIfAbsent` | Rejected at construction | Pass |

### 5.4 Rate limiting — `tests/ratelimit.test.js` (6 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-RL-01 | Capacity consumed | Then refuses | Pass |
| TC-RL-02 | Refill over time | Tokens return | Pass |
| TC-RL-03 | Long idle | Capped at capacity | Pass |
| TC-RL-04 | `msUntilAvailability` | Exact wait | Pass |
| TC-RL-05 | 25 takes | Non-blocking (< 500 ms) | Pass |
| TC-RL-06 | Invalid config | `TypeError` | Pass |

### 5.5 Subscribers / POPIA — `tests/subscribers.test.js` (9 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-SUB-01 | Subscribe | Row with consent timestamp and text | Pass |
| TC-SUB-02 | Re-subscribe to another zone | Moves zone, keeps original consent | Pass |
| TC-SUB-03 | `/stop` | Row deleted (`deleted = 1`) | Pass |
| TC-SUB-04 | Repeat `/stop` | `deleted = 0`, no error | Pass |
| TC-SUB-05 | Invalid zone | `ValidationError(INVALID_ZONE)`, no write | Pass |
| TC-SUB-06 | Unsupported platform | Rejected | Pass |
| TC-SUB-07 | Empty / 129-char user id | Rejected | Pass |
| TC-SUB-08 | Paging 5 recipients, limit 2 | 2/2/1, no duplicates | Pass |
| TC-SUB-09 | Invalid paging args | Rejected | Pass |

### 5.6 Dispatch — `tests/dispatcher.test.js` (9 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-DSP-01 | Successful send | `sent`, one transport call | Pass |
| TC-DSP-02 | Permanent failure (blocked bot) | `failed_permanent`, not retried | Pass |
| TC-DSP-03 | Retryable failure | Rethrown for backoff | Pass |
| TC-DSP-04 | Unknown error (ECONNRESET) | Converted to retryable | Pass |
| TC-DSP-05 | Empty token bucket | Retryable with `retryAfterMs ≥ 900` | Pass |
| TC-DSP-06 | Fan-out 5 users, page 2 | 5 enqueued once each | Pass |
| TC-DSP-07 | Empty zone | 0 enqueued | Pass |
| TC-DSP-08 | `maxRecipients = 3` | Truncated flag set | Pass |
| TC-DSP-09 | Subscriber unsubscribes mid-broadcast | Not enqueued on later page | Pass |

### 5.7 Ingestion — `tests/ingestion.test.js` (6 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-ING-01 | First poll | Cache seeded, 0 jobs | Pass |
| TC-ING-02 | Stage 4 → 6 | 1 job, id `fanout:zone-a:stage-6`, copy says "Stage 4 → Stage 6" | Pass |
| TC-ING-03 | 4 → 6 → 4 → 6 | Only 2 jobs; 4th suppressed; cache still advanced | Pass |
| TC-ING-04 | Identical repeat | `unchanged`, 0 jobs | Pass |
| TC-ING-05 | One zone throws | Other zone still processed | Pass |
| TC-ING-06 | `ALERT_ON_FIRST_SYNC=true` | First snapshot announced | Pass |

### 5.8 Webhook security — `tests/webhookSecurity.test.js` (5 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-SEC-01 | Correct secret | Accepted | Pass |
| TC-SEC-02 | Wrong / empty / longer secret | Rejected | Pass |
| TC-SEC-03 | Secret configured, no header | Rejected even in dev mode | Pass |
| TC-SEC-04 | Header casing variants | Accepted | Pass |
| TC-SEC-05 | No secret + insecure allowed | Only then accepted | Pass |

### 5.9 Telegram handler — `tests/handleUpdate.test.js` (9 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-UPD-01 | `/subscribe zone-a` | Row created, confirmation sent | Pass |
| TC-UPD-02 | Unknown zone | Refused, nothing written | Pass |
| TC-UPD-03 | `/subscribe` bare | Format guidance | Pass |
| TC-UPD-04 | `/stop` | Row erased + confirmation mentions deletion | Pass |
| TC-UPD-05 | `/status` before/after subscribe | Correct both times | Pass |
| TC-UPD-06 | `/start`, `/help` | Guidance, no writes | Pass |
| TC-UPD-07 | Bot kicked | Row purged | Pass |
| TC-UPD-08 | Sticker / missing message | Ignored, no throw | Pass |
| TC-UPD-09 | Unknown command | Help reply | Pass |

### 5.10 Message rendering — `tests/format.test.js` (8 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-FMT-01 | Escalation | "Stage 4 → Stage 6", SAST times, `/stop` footer | Pass |
| TC-FMT-02 | Cleared | "suspended", never "Stage 0" | Pass |
| TC-FMT-03 | Huge provider notes | ≤ 4096 chars, `…`, max 3 slots | Pass |
| TC-FMT-04 | `truncate` boundaries | Correct | Pass |
| TC-FMT-05 | Unsubscribe copy | States data was deleted | Pass |
| TC-FMT-06 | Error copy | Actionable, no `undefined` | Pass |
| TC-FMT-07 | Status copy | Subscribed/unsubscribed | Pass |
| TC-FMT-08 | Unparseable event time | Falls back to raw value | Pass |

### 5.11 HTTP surface — `tests/server.test.js` (9 cases)

| ID | Case | Expected | Result |
| --- | --- | --- | --- |
| TC-SRV-01 | `GET /healthz` | 200 `{status:"ok"}` | Pass |
| TC-SRV-02 | `GET /readyz`, all dependencies up | 200 `{redis:"ok", postgres:"ok"}` | Pass |
| TC-SRV-03 | `GET /readyz`, Postgres down | 503 with failing check named | Pass |
| TC-SRV-04 | Webhook without secret | 401, handler never invoked | Pass |
| TC-SRV-05 | Authenticated update | 200, handler runs afterwards | Pass |
| TC-SRV-06 | Replayed `update_id` | 200 `{duplicate:true}`, handled once | Pass |
| TC-SRV-07 | Array body | 400 `invalid_update` | Pass |
| TC-SRV-08 | Unknown route | 404 JSON | Pass |
| TC-SRV-09 | Handler throws | Server stays up, `/healthz` still 200 | Pass |

## 6. Automated results

```
> node --test "tests/*.test.js"

ℹ tests 86
ℹ pass 86
ℹ fail 0
ℹ duration_ms ~1970
```

### Coverage (`node --test --experimental-test-coverage`)

| File | Line % | Branch % | Func % |
| --- | --- | --- | --- |
| core/commands.js | 100.00 | 96.43 | 100.00 |
| core/dedup.js | 96.67 | 100.00 | 75.00 |
| core/diff.js | 98.84 | 65.88 | 100.00 |
| core/dispatcher.js | 100.00 | 76.67 | 100.00 |
| core/format.js | 96.95 | 83.33 | 90.00 |
| core/ratelimit.js | 100.00 | 94.12 | 100.00 |
| core/subscribers.js | 100.00 | 89.29 | 100.00 |
| core/webhookSecurity.js | 94.44 | 76.92 | 100.00 |
| services/ingestion.js | 100.00 | 78.13 | 100.00 |
| webhooks/handleUpdate.js | 93.14 | 85.71 | 100.00 |
| webhooks/server.js | 92.86 | 92.86 | 100.00 |
| **All tested modules** | **97.18** | **82.62** | **92.45** |

Branch coverage on `diff.js` is 65.9% because defensive branches for malformed
provider payloads (null stage, cancelled events, missing notes) have only one
witness each. Acceptable for a release candidate; targeted cases are scheduled
for v1.1.

Files intentionally excluded from unit coverage: `src/index.js`,
`src/workers/*`, `src/services/telegram.js`, `src/providers/espClient.js`.
They require a broker, network, or process lifecycle and belong to the
integration suite below.

## 7. Manual and integration cases (defined, not yet executed)

| ID | Scenario | Steps | Pass criteria |
| --- | --- | --- | --- |
| MT-01 | Live ESP smoke | `ESP_PROVIDER=esp`, valid token, one cycle | Log shows one credit used; authoritative area data cached; `/area` result hash stored |
| MT-02 | Live Telegram delivery | `/subscribe`, force a stage change in cache | Message arrives on the phone within 5 s; reply to `/stop` erases the row |
| IT-01 | Redis dedup contention | Fire two ingestion cycles concurrently | Exactly one fan-out job |
| IT-02 | BullMQ rate limit | Enqueue 100 recipients | Completion takes ≥ 4 s at 25/s; zero 429s |
| IT-03 | Postgres uniqueness | Subscribe the same user twice | One row, zone updated |
| IT-04 | Dead-letter | Transport returns 500 for one user, 5 attempts | One document in `alerts-dead`, other recipients unaffected |
| MT-03 | Zombie webhook | POST without secret | 401, no DB change |
| MT-04 | Quota exhaustion | Set limit to 1, poll twice | Second poll logs `QUOTA_EXCEEDED`; no HTTP call |

## 8. Performance target (PT-01)

Precondition: Redis running, `TELEGRAM_MAX_PER_SECOND=25`, transport stubbed.

```
enqueue 10 000 send jobs → worker drains queue
```

| Metric | Target | Rationale |
| --- | --- | --- |
| Sustained rate | 23–25 msg/s | Below Telegram's 30/s ceiling with headroom |
| Total time for 10k | ~7 minutes | 10 000 / 25 |
| Worker RSS growth | < 100 MB | Paged fan-out, per-message jobs |
| Failed jobs | 0 | No synthetic failures |

Not executed this cycle (no staging environment); the queue design bounds
memory per job at one message, which is the property under test.

## 9. Defect summary

| Severity | Found | Fixed & verified | Open |
| --- | --- | --- | --- |
| Critical | 2 | 2 | 0 |
| High | 3 | 3 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 3 | 2 | 1 (deferred, documented) |
| **Total** | **13** | **12** | **1** |

Full detail in [BUG-REPORTS.md](BUG-REPORTS.md).

## 10. Risks carried into release

| ID | Risk | Mitigation | Owner |
| --- | --- | --- | --- |
| RISK-01 | Free-tier credits exhausted → no alerts for the rest of the day | Pre-flight budget + interval validation + `/readyz` surfacing; alert when usage > 80% | Operator |
| RISK-02 | Provider changes payload shape | Adapter isolation; `normaliseArea` degrades to `events: []`, `stage: null` (never a false "cleared") | Engineer |
| RISK-03 | ESP endpoint version drift (v3 beta claims unverified) | Base URL configurable, adapter pinned, contract check in MT-01 before switching | Architect |
| RISK-04 | Telegram 429 storm during a national stage change | Worker limiter + token bucket + 5 retries with backoff | Engineer |
| RISK-05 | Operator sets interval too low | Boot refuses inconsistent config | Engineer |

## 11. Sign-off

| Role | Name | Result | Date |
| --- | --- | --- | --- |
| QA Tester | — | PASS, 86/86, 0 open Critical/High | 2026-11-02 |
| System Architect | — | As-built matches SDD v1.1 | 2026-11-02 |
| Product Owner | — | Pending acceptance of MT-01/MT-02 on staging | — |
