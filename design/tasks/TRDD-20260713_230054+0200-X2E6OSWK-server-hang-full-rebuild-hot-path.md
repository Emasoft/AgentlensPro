---
trdd-id: X2E6OSWK
title: Server degrades into a 100% CPU spin and every request hangs — full session rebuild on a 4s timer and on every tool call
column: dev
created: 2026-07-13T23:00:54+0200
updated: 2026-07-13T23:00:54+0200
current-owner: main
task-type: bugfix
severity: critical
scope: project
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-13

**Symptom (MEASURED, not inferred).** The standalone server degrades over ~40 min into a
permanent **~100% CPU spin** (observed pid 16412: 103.5 / 112.2 / 89.6 %CPU, RSS 2.6 GB,
uptime 42 min). The event loop starves, so **EVERY** request hangs — not just MCP tools:
`/api/server-stats` (plain REST) and a raw `tools/call get_account_status` both time out at
60–150 s and never return. `agentlenspro <anything>` therefore hangs. Data at the time:
**404,917 spans / 57,124 in the 24h window / 16,942 log session cards**.

**ROOT CAUSE (code-verified).** A FULL, uncached re-summarization runs on a 4-second timer:
- `standalone/server.ts:863` — `setInterval(tickBurn, 4000)`
- `tickBurn` → `gatherBurn()` (`standalone/server.ts:668`)
- `gatherBurn:669` — `const sessions = buildSessionSummary()?.sessions ?? []`
- `buildSessionSummary()` (`standalone/server.ts:1459`) re-runs **`summarizeSpans(spans)` over
  57k spans** AND **`mergeOtelAndLogSessions(...)` + `linkSubagentTranscripts(...)` over all
  16,942 log cards**, then re-sorts them — every single call.

The same full rebuild ALSO runs on **every MCP tool call**: `src/mcpServer.ts:2475`
`const sessions = opts.getSessions()` → `buildSessionSummary()` (standalone wires it at
`standalone/server.ts:744`). And `runLogScan` is on its own `setInterval(…, 5_000)` (`:934`).

So the cost is O(spans + sessions·merge) **every 4 s**, plus once per tool call, with **no cache
and no re-entrancy guard**. It was fine when the corpus was small; once the 4 s job stops fitting
in 4 s, firings overlap, work piles up, and the process saturates permanently. That the failure
*develops over time* (fast at boot, hung 40 min later) is the signature of exactly this.

**NOT a regression from TRDD-OCNHOHE9** (the cache-expiry feature): `get_account_status` — which
touches none of that code — hangs identically, and the 4 s full-rebuild predates it.
⚠ HONESTY: the one bisect I attempted was **INVALID** (the old process still held :4316, so
`server start` no-opped and I re-tested the same hung pid). RE-BISECT properly (kill the port
holder FIRST) before asserting the regression claim as proven.

**NEXT ACTION** — in order:
1. Re-bisect validly: kill any :4316 holder, boot a build from `main` (no OCNHOHE9), confirm the
   spin reproduces. Record the time-to-hang.
2. Instrument: time `buildSessionSummary()` (and separately `summarizeSpans`,
   `mergeOtelAndLogSessions`, `linkSubagentTranscripts`) at the real corpus size. Find whether the
   merge/link step is O(n²) — 16,942 cards makes that ~287 M ops per call, 15×/min.
3. Fix (design below), then prove: server stays responsive under the real corpus for ≥1 h with
   p99 tool latency bounded.

**Fix design (do NOT skip the measurement in step 2 — pick the fix the data supports)**
- **Memoize `buildSessionSummary()`** behind a dirty-flag / generation counter invalidated by span
  ingest + `runLogScan` results. This alone removes both the 4 s re-tick cost and the per-tool-call
  cost. Cheapest, highest-leverage.
- **Re-entrancy guard** on `tickBurn` + `runLogScan`: skip (or coalesce) a firing while the previous
  run is still in flight, so overlap can never pile up. A timer must NEVER be able to outrun itself.
- **Incrementalize** the merge: `logSessions` is already a Map keyed by sessionId — merging/linking
  should update only the cards that CHANGED (`runLogScan` already returns only advanced sessions),
  not rebuild all 16,942 every tick.
- If, after the above, the summarization is still the bottleneck at scale, escalate per the USER's
  standing directive: **implement a Rust helper** for the hot summarize/merge path rather than
  accepting a slow rebuild.
- Invariant to encode in a test: **no periodic job may run a whole-corpus rebuild**, and the server
  must answer a tool call while ingestion is saturated.

**Load-bearing facts / gotchas**
- `agentlenspro server start` is a NO-OP when something still holds :4316 — it silently "succeeds"
  against the OLD process. Kill the port holder (`lsof -ti :4316`) before any bisect, or the
  experiment is worthless (this cost me one wrong conclusion).
- macOS `sample <pid>` failed (rc=1, needs perms) — use `ps -o %cpu` to distinguish CPU-spin from
  I/O-block (it was a spin), or boot node with `--cpu-prof` for a real profile.
- The server holds a big corpus by design (404k spans, 30 d retention) — the fix must scale WITH the
  corpus, not assume it stays small.

## Verification
- `bash scripts/safe-deploy.sh --dry-run` GREEN.
- New regression test: a periodic tick over a large synthetic corpus must not exceed its interval,
  and a tool call must return under load.
- Live: run ≥1 h at the real corpus; `ps -o %cpu` stays low-idle; tool calls return in < 2 s.

## Approval log
- Tier 0: in-scope bugfix on the project's own server. USER explicitly directed it ("we cannot
  permit that the server hangs in no circumstances… if a speed problem arises that cannot be
  optimized further, you must implement rust helpers").
