---
trdd-id: 465EXTJ6
title: alcore is not at parity with the TypeScript server on 14 measured behaviours and it is the only backend that ships
column: dev
created: 2026-08-29T20:43:34+0200
updated: 2026-08-29T21:35:00+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: 1B98LCVR
severity: HIGH
relevant-rules: []
implementation-commits: []
---

# alcore is not at parity with the TypeScript server on 14 behaviours

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**Measured, not inferred.** `AGENTLENS_TEST_ENGINE=alcore` (added in `f2f81c5`) boots the whole
test suite against the Rust server instead of `standalone/server.js`. Result: **2515 passing, 15
failing** — 14 real parity gaps plus one already-carded flake (TRDD-B7DSTJLS's
`cacheBreakTimeline`).

**These are not new regressions.** `rustBinResolve` has preferred alcore on every supported
platform since 2.30.1, so all 14 are already live in published installs. What changed today is
that they are **enumerated instead of assumed absent** — and that `standalone/server.js` no longer
ships (`d58d6e1`), so there is no longer a fallback that could mask any of them on a supported
platform.

### The 14, by area

| n | area | what fails |
|---|---|---|
| 3 | **MCP CORS** | no scoped `Access-Control-Allow-Origin`; an allowed loopback origin is not echoed; a body over the 4 MB cap does not destroy the socket — that cap exists because uncapped buffering was an OOM vector |
| 2 | **liveness + degradations** | `POST /api/statusline-samples` does not bump the capture-liveness clock (TRDD-8ADTIGKT); a swallowed OTLP ingest failure is not counted by name in `degradations` |
| 3 | **admission control** | no shed at the hard RSS wall; `shedTotal` stays 0; a concurrent burst is not shed |
| 1 | **hook spool** | the spool is not drained and reingested on boot — spooled events stay unread |
| 5 | **P5 window auto-calibration** | a rate-limit StopFailure through the ingest path never writes `burn-config.json`, so none of the calibration rules (don't lower on a smaller replay, don't calibrate on a rollover, don't calibrate on a non-rate-limit stall, never overwrite a user-set capacity) are exercised at all |

**Every one is BEHAVIOUR, not a missing route.** TRDD-1B98LCVR's scope report warned its endpoint
list was "a FLOOR, not a complete inventory" and that both gaps found before this were log lines
and env reads invisible to an endpoint diff. This confirms that warning at scale: an endpoint diff
would have found none of these 14.

### Severity, stated honestly

`admission control` and the `4 MB body cap` are the two that carry real risk — both exist to bound
memory under load, and the ingest measurements from the same day put 1,000,080 spans and ~20 GB RSS
in the window at peak. The spool drain is data-loss-shaped (events accepted, then never reingested).
The MCP CORS gaps are a read-scope hardening (TRDD-F6BM1BDI) that alcore does not enforce. P5
calibration is a feature that silently does nothing.

## 2026-09-01 — 7 of 14 CLOSED (`0c1edbe`, `ba3e180b`); MCP CORS narrowed with file:line

Closed: admission control ×3, hook-spool drain, statusline liveness clock, `degradations` counter,
P5 calibration ×5 → **14 gaps became 7**.

**MCP CORS — NARROWED, not started. The assigned worker landed NOTHING; `serve_mcp` is untouched.**
Read before writing code — this is the analysis that would otherwise be redone:

`serve_mcp` (`ui.rs:3540`) routes `/mcp` GET and POST to the SHARED `handle`, which already applies
`is_disallowed_cross_origin` and the ACAO policy. So the gap is **not** a missing origin policy —
it is what happens on the two paths that never reach that preamble:

1. **The OPTIONS preflight returns early at `ui.rs:3557-3562`** with `204` and NO CORS headers at
   all. The code's own comment concedes it: *"The CORS headers themselves are added by `handle`'s
   preamble for real requests."* A preflight that carries no ACAO is exactly the "no scoped ACAO"
   the test reports.
2. **The 4 MB cap is absent on this listener.** `handle` uses `MAX_BODY_BYTES` = 64 MB (the OTLP
   contract). POST /mcp EXECUTES a tool, and its cap is 4 MB precisely because uncapped buffering
   there was an OOM vector — so the cap has to be applied per-listener, not inherited from OTLP.

**Do NOT write a second origin policy.** `is_disallowed_cross_origin` and `read_body_capped` are
already in `ui.rs`; the fix is to apply them on these two paths.

**One caution about reading the test output:** the first ACAO failure asserts *"health check still
responds"*, which reads like a CORS assertion but is a LIVENESS one — it means the server died
earlier in the file. Fix the cap first and re-read the list; the three may not be three independent
bugs.

## 2026-09-01 (later) — MCP CORS CLOSED; the 5 P5 failures are ONE upstream cause

**9 of 14 closed.** `06febeae` fixed the MCP preflight and ALL THREE ACAO failures went with it —
the card's prediction held: the first one asserts *"health check still responds"*, a LIVENESS
assertion, so the file was dying early and taking the other two with it. Three symptoms, one bug.

**COUNT CORRECTION: 5 remain, not 4** (an earlier summary said 4). 14 − 9 = 5, all P5.

**THE 5 P5 FAILURES ARE NOT A CALIBRATION BUG. Do not debug `burn_calibration.rs` — it is fine.**
Only the FIRST one is real; the other four are `ENOENT ... burn-config.json`, i.e. downstream of it
never being written. And the first fails on a PRECONDITION, before calibration is ever reached:

```
AssertionError: account window must exist before the stall. accounts: <server boot log>
```

The test establishes an account window by ingesting, THEN sends the rate-limit StopFailure. Under
alcore the account window is not there when it checks — so the stall has nothing to measure and
`calibrate_from_stop_failure` correctly declines. The gap is in the **account registry / window
establishment** path, a different subsystem entirely.

**RETRACTED — my own caution above was wrong.** I suggested the `accounts:` value printing the
server boot log meant the test was reading the wrong stream. It is not: the assertion is
`` `account window must exist before the stall. accounts: ${getLog().slice(-500)}` `` — the test
DELIBERATELY dumps the last 500 bytes of the server log into its own failure message for diagnosis.
Reading the test settled it; guessing from the output shape did not.

**NARROWED FURTHER — the computation is present, so look at its INPUT, not the maths.**
- The test's precondition is `GET /api/burn-status` → `accountWindows[]`, found by `accountUuid`
  (`serverCalibration.test.ts:119-124`), after `ingestAccountConsumption` posts three consumption
  events. The test's own comment: *"a failure here means the fixture broke, not the calibration."*
- alcore **does** compute that field: `compute_account_window_budgets`
  (`burn/monitor.rs:630`), wired at `burn/monitor.rs:889`, and labelled in `burn/runtime.rs:141`.
  So `accountWindows` is neither missing nor stubbed.

⇒ The failure is in **what feeds those events** — the ingested consumption is not reaching the
burn-event list, or the per-event account attribution (`accountUuid`) is not being extracted from
it. **Investigate the event SOURCE, not `compute_account_window_budgets` and not
`burn_calibration.rs` — both are correct.**

**THE CHAIN, TRACED TO ITS SOURCE (2026-09-01, final narrowing):**

```
GET /api/burn-status → accountWindows[]            (test asserts this is non-empty)
  ← compute_account_window_budgets(events,…)        burn/monitor.rs:630, wired :889
      groups by  s(e,"accountUuid")                 :633  — empty events ⇒ empty output
  ← events                                          built at burn/monitor.rs:307
  ← api_request_events(card)                        burn/monitor.rs:247
      reads card["timeline"][] where type=="api_request"   :250-253
```

⇒ **The burn events are derived from SESSION CARDS' `timeline[]`, not from raw spans.** So the
precondition fails if alcore's session cards do not carry `timeline[]` entries of
`type: "api_request"` (with `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreateTokens`
and an `accountUuid`) after the fixture's consumption is ingested.

**MEASURED AGAINST THE LIVE SERVER — alcore POPULATES `accountWindows` CORRECTLY:**

```
$ curl -s localhost:3000/api/burn-status   (the live alcore, real data, 9h+ uptime)
accountWindows count: 2
  acct=75099fe9  events=134
  acct=None      events=2
```

**So the whole chain WORKS in production.** `api_request_events` → `compute_account_window_budgets`
→ `accountWindows` produces real per-account windows with real event counts against real ingested
data. The product is not broken here.

⇒ **The remaining 5 are very likely a FIXTURE problem, not an alcore parity gap** — which is
exactly what the test's own comment predicts: *"a failure here means the fixture broke, not the
calibration."* `ingestAccountConsumption` posts a synthetic shape that the TS server accepted and
that alcore does not turn into a card timeline (e.g. it posts raw consumption where alcore needs
`api_request` timeline entries on a session card).

**CORRECTION (same session, minutes later): the FIXTURE hypothesis is WRONG — I read it.**

`ingestAccountConsumption` (`serverCalibration.test.ts:102-109`) posts **real OTLP**:
`POST /v1/logs` with `{resourceLogs:[{scopeLogs:[{logRecords}]}]}`, carrying one `accountRecord`
plus one `apiRequestRecord` per event. That is the SAME wire path Claude Code's own telemetry uses
— not a synthetic shape alcore never supported. So "fix the fixture" is off the table.

**THE SHARPER HYPOTHESIS, and it fits every observation:** the test boots with `--no-log-scan` and
feeds **OTEL only**. The live server that DOES populate `accountWindows` runs **with** the JSONL
log scan. So alcore may build session-card `timeline[]` entries from **transcripts** but not from
**OTEL `api_request` log records** — and `api_request_events` (`burn/monitor.rs:247`) reads only
`card["timeline"]`. An OTEL-only alcore would then have cards with no `api_request` timeline, and
therefore no `accountWindows`, exactly as the test reports.

That would be a REAL parity gap (the TS server built these from OTEL), and it is one cause behind
all 5 — not five separate ports.

**RUN. HYPOTHESIS 3 CONFIRMED, AND NARROWED ONE STEP FURTHER (2026-09-01).**

Scratch alcore, `--no-log-scan`, OTEL-only, POST `/v1/logs` with one `user_account` record +
three `api_request` records carrying `user.account_uuid=acct-otel-x`, then `GET /api/burn-status`:

```
ingest_http=200
accountWindows = 1  ['None']        ← built, but the account is the UNKNOWN bucket
```

**The window IS built from OTEL — so "alcore ignores OTEL for card timelines" is WRONG too
(hypothesis 3 as originally worded).** What is actually broken is narrower and exact: the
**per-event ACCOUNT ATTRIBUTION is lost**. Every `api_request` lands in the `accountUuid: null`
bucket instead of `acct-otel-x`, so `burnStatusAccount('acct-cal-a')` finds nothing and the
precondition fails.

⇒ **THE BUG: `user.account_uuid` on an OTLP `api_request` log record is not carried onto the
event that `compute_account_window_budgets` groups by** (`s(e,"accountUuid")`,
`burn/monitor.rs:633`). Either the ingest transform drops the attribute, or the card timeline
entry stores it under a different key than `api_request_events` reads
(`burn/monitor.rs:247-258`).

**CORRECTION — the attribution code IS PRESENT on both levels. Do not "add" it.**

Traced both ends before writing any fix, and every link exists:
- interaction card: `summarize/claude.rs:687-696` sets `accountId` from `user.account_uuid`,
  falling back to the session registry — the exact shape of `claude.ts:587`.
- session rollup: `summarize/claude.rs:876` —
  `ordered.iter().find_map(|s| s.get("accountId").filter(truthy))` — the exact shape of
  `claude.ts:140`'s `ordered.find(s => s.accountId)?.accountId`.
- reader: `burn/monitor.rs:262-264` copies `card["accountId"]` onto the event as `accountUuid`.

So "the Rust summarizer never sets accountId" would have been a FALSE diagnosis, and I nearly
recorded it. The chain is complete.

**WHAT THAT MEANS FOR MY OWN PROBE — read this before trusting it.** The `accountWindows = 1
['None']` result came from a payload I HAND-ROLLED, not from the fixture. My records may simply not
match the attribute shape alcore's log transform expects (I guessed `stringValue` attrs and an
event-name body). **A hand-built payload proving "attribution is lost" proves nothing if the
payload itself is wrong** — that is the same class of error as reading a half-written output file.

**NEXT, and do it in this order:**
1. Re-run the probe using the FIXTURE's own record builders (`accountRecord` / `apiRequestRecord`
   in `serverCalibration.test.ts`), not a hand-rolled payload. If `accountWindows` then carries the
   uuid, my probe was the bug and the real failure is elsewhere in the test's setup.
2. Only if it STILL comes back `None`, compare the fixture's attribute keys against
   `get_attr_str(interaction, "user.account_uuid")` and the log→interaction transform — the defect
   is then in that mapping, with all three links above verified present.

**FOUR hypotheses have now been wrong on this card** (stat-bound, fixture-broken, OTEL-ignored,
attribution-missing). Every one died to a measurement. Run step 1 before writing a line of code.

**(superseded) START HERE, and it is a 2-file read:** compare the attribute name the ingest transform writes
against the key `api_request_events` reads. On the live server the accounts resolve because the
JSONL scan supplies them by another route — which is exactly why this stayed invisible in
production and only shows up OTEL-only.

**This is now a single, located defect behind all 5 failures — not five ports.**

**(superseded) DECIDING TEST, cheap and unambiguous:** boot alcore on a scratch dir with `--no-log-scan`, POST
the fixture's own `/v1/logs` payload, then `GET /api/burn-status`. Empty `accountWindows` confirms
the OTEL path is the gap; populated means the difference is elsewhere and this hypothesis dies too.
**Run that before writing any code** — this is the third hypothesis in this card, and the first two
were both wrong.

**RECLASSIFY BEFORE FIXING.** Do not "port" anything until this is settled: compare what
`ingestAccountConsumption` posts against what the LIVE feed produces for one card
(`/api/sessions` → a card's `timeline[]`). If the fixture's shape is simply one alcore never
supported, the honest resolution is to fix the FIXTURE, and the parity count drops from 5 to 0 —
the TypeScript server would then be blocking on nothing.

**START HERE:** ingest the fixture, then dump one session card and check whether `timeline[]`
contains `api_request` entries at all. That single observation splits the remaining work in two:
cards have no timeline ⇒ the card builder is the gap; cards have a timeline but no `accountUuid`
⇒ the attribution is the gap. Everything downstream of it is already verified correct.

**NEXT: verify the account window independently** — boot alcore on a scratch dir, ingest the same
fixture the test uses, and query the account registry directly. That answers "is alcore not
populating it" vs "is the test reading it wrong" without touching either the calibration port or
the test.

## NEXT ACTION

Work them in risk order, not list order: **admission/RSS shedding + the body cap first** (bounded
memory under load), **then the spool drain** (data loss), **then MCP CORS**, **then P5
calibration**. Each one:

1. Read the TS implementation, port it to alcore, and make the corresponding test pass under
   `AGENTLENS_TEST_ENGINE=alcore` **without** regressing it under the default engine.
2. Mutation-verify: revert the port and the test must fail.

**Do NOT flip `AGENTLENS_TEST_ENGINE=alcore` to the default until all 14 pass** — the whole point of
the opt-in is that a red suite with 14 unrelated causes tells you nothing. Flipping it is the
closing act of this card, and it is what makes TRDD-1B98LCVR box 4 (deleting `standalone/server.ts`)
safe.

## Acceptance

- [x] **3 of 14 done — admission control** (`admission.rs`, mutation-verified; failure count 15 → 11).
- [ ] All 14 pass under `AGENTLENS_TEST_ENGINE=alcore`, each mutation-verified.
- [ ] The suite is green under BOTH engines simultaneously (no gap closed by weakening a test).
- [ ] `AGENTLENS_TEST_ENGINE=alcore` becomes the default and the opt-in is removed.
- [ ] TRDD-1B98LCVR box 3 ticked with this card as evidence.

## Notes and lessons learned
