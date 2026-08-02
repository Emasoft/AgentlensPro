---
trdd-id: X2E6OSWK
title: Server degrades into a 100% CPU spin and every request hangs — full session rebuild on a 4s timer and on every tool call
column: human_review
created: 2026-07-13T23:00:54+0200
updated: 2026-08-02T11:35:13+0200
current-owner: main
task-type: bugfix
severity: critical
scope: project
implementation-commits: [3b1520a, 956c006, 3a8fe7c, 4949af7, 4b4dc8f]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-16 16:24

**✅ ALL DELIVERABLES SHIPPED (commit 4b4dc8f closes the last two) — column → ai_review.**
The wedge class ("unbounded synchronous O(corpus) work inline in one request") is now closed at
THREE layers: every corpus-fanning drill is bounded, any future wedge names itself in the log, and
the watchdog self-heals a starvation that slips through anyway.

- **Sibling-handler sweep DONE (4b4dc8f)**: `scanWithBudget` is the ONE bounded-scan primitive
  (setImmediate macrotask yield per item + deadline — a bare await of a resolved promise drains
  only microtasks and still starves I/O). Swept results:
  - `check_cache_expiry` default path — WAS a full wedge (reparsed EVERY main synchronously to
    find the caller's newest session). Now: rank by card-metadata lastActivityMs, reparse only the
    top EXPIRY_NEWEST_PROBE=12 (an LLM request IS card activity, so the true newest cannot rank
    below the probe). Live: 20+min hang → **6.5s** post-restart, picks the correct session.
  - `check_cache_expiry --all` — WAS a synchronous map over the whole corpus. Now newest-first
    scanWithBudget + coverage block. Live: returns at the 20s budget, **"SAMPLE: 78 of 13248"**.
  - `get_cache_break_report` workspace mode — pool capped at 20 but one sync reparse per
    iteration; now scanWithBudget + stoppedEarly note.
  - Audited CLEAN (no fix needed): find_context_hogs + get_context_inflation_report (capped
    pools, per-iteration REAL async I/O via getComposition), find_relevant_context +
    predict_session_cost (card-metadata only, no reparse), get_call_context /
    get_session_detail / conversation / history (single-session).
  - get_cost_by_cause refactored onto the shared primitive; CAUSE_SCAN_TIME_BUDGET_MS renamed
    DRILL_SCAN_TIME_BUDGET_MS (shared by every drill).
- **Per-tool duration logging DONE (4b4dc8f)**: `handleMcpRequest` peeks tools/call and logs
  `tool <name> start` + `tool <name> done in Xms (status N)` at the one choke point every tool
  call crosses. The START line is the wedge-namer — a wedged handler never finishes, so the last
  start with no done in `~/.agentlens/server.log` IS the culprit. HTTP /api routes were already
  timed per-request by instrumentResponse (requestLog).
- Tests: 3 new bounded-scan tests (probe cap + precision ranking; budget stop honest coverage;
  complete-coverage label). Suite **1303 passing / 0 failing**, tsc 0, lint 0. Deployed pid 85113
  (esbuild succeeded + server restart; symbols grep-verified in the bundle).
- **Remaining gate**: human review (ai_review → human_review → complete). Shipped in v2.8.0 were
  956c006/3a8fe7c/4949af7; commit 4b4dc8f is post-2.8.0 and rides the next release.

(Superseded 16:0x addendum, kept for lineage:)

**CULPRIT NAMED + BOUNDED (commits 956c006, 3a8fe7c) — wedge class closed for this handler;
watchdog + per-request logging still OPEN (that's why column stays dev).**

- **Named**: `handleGetCostByCause` leaderboard mode — `scanPool.flatMap(asTimeline)` ran up to 50
  SYNCHRONOUS full-transcript reparses inline (after a restart every disk-restored card is
  timeline-stripped, so the first cross-session drill reparses ~50 multi-MB JSONLs back-to-back).
  Matches every frame of the 15:24 native sample (flatMap + stat/getdirentries/open + Date.parse
  + GC). CONFIRMED as the failure shape; the 15:00 request itself is unprovable without
  per-request logs (hence the logging deliverable below).
- **Bounded (956c006)**: one session per macrotask (queued requests interleave) + a 20s deadline
  with honest coverage (`stoppedEarly`, note explains reparsed timelines are cached so a retry
  widens). Tests: yield-interleave proof + budget stop. Live: post-restart worst case returns
  promptly, server responsive throughout.
- **Bonus defect found + fixed (3a8fe7c)**: the pool ranked AND windowed by startTime, so on a
  busy fleet the 50 newest-STARTED cards were ephemeral subagents (flagship active session ranked
  #446) and machine-wide attribution read 0 while single-session drills showed 1155 calls. Now
  lastActivityMs ranks + windows. Live proof: leaderboard 0 → **5974 attributed calls**.
- **Watchdog SHIPPED (4949af7)**: `src/loopWatchdog.ts` — main beats a SharedArrayBuffer every 1s
  (a starved loop cannot beat; the silence is the signal); a worker thread checks it and on a 60s
  stall spawns a detached restarter (SIGKILL — TERM is provably ignored — then respawn same
  execPath/argv/env). Guards: system-sleep detection (worker's own timer gap), 120s min-uptime
  (no boot crash-loop), unref everywhere, fail-soft start. Tested END-TO-END on a real child that
  starves its own loop (SIGKILL observed + detached respawn marker) + healthy-loop + grace-window
  tests. Envs: AGENTLENS_WATCHDOG=off, AGENTLENS_WATCHDOG_STALL_S. Deployed pid 69197.
- **STILL OPEN (next actions)**: (1) per-request duration logging on drill routes so any future
  wedge names itself; (2) sweep the OTHER corpus-fanning drill handlers (cache_break/
  context_inflation/find_context_hogs/check_cache_expiry machine scan) for the same
  unbounded-synchronous shape and apply the same yield+budget pattern.

(Superseded 15:24 addendum, kept for lineage:)

**⟲ REOPENED — the wedge RECURRED at 15:0x on 2026-07-16, ~3h34m after boot. The 14:10 addendum
below ("FIXED + LIVE-PROVEN") was PREMATURE: 3b1520a measurably reduced steady-state CPU but did
NOT eliminate the failure class at today's corpus (455k stored spans / 17.3k cards).**

**Recurrence evidence (measured, preserved):**
- pid 54681: **104.5% CPU, RSS 3.0 GB, uptime 3h34m**; `/api/server-stats` and every tool hang;
  SIGTERM ignored (event loop fully starved) → SIGKILL required; fresh boot healthy (pid 88978).
- 8s native sample (preserved:
  `reports/cpu-profile/20260716_152409+0200-wedge-native-sample-pid54681.txt`): the MAIN thread is
  inside an **HTTP-request Promise handler** (http_parser → MakeCallback → RunMicrotasks →
  PromiseFulfillReactionJob) running a **giant `Array.prototype.flatMap`** (1411/6311 samples),
  with top-of-stack `stat` (551) + `__getdirentries64` (303) + `__open_nocancel` (269) — a
  synchronous per-request DIRECTORY WALK — plus `DateParser` (Date.parse in a hot loop) and GC
  pressure (SafepointTable/SizeFromMap). JS frames are JIT-anonymous — native sampling cannot
  name the function; a V8-level profile is required to convict.
- Distinct from the 07-13 signature: this is REQUEST-DRIVEN (one handler doing O(corpus)
  synchronous work inline), not the periodic rebuild storm 3b1520a fixed.

**NEXT ACTION (in order):**
1. Name the culprit: grep the drill handlers for the signature — `flatMap` over corpus-sized
   arrays + `listSessionFileIds`/readdir walks + `Date.parse` per entry. Prime suspects: the
   `fileBackedPool` consumers (find_relevant_context / predict_session_cost scan file-backed
   pools then parse transcripts), get_cost_by_cause's CAUSE_SCAN_CAP×getTimeline reparse (incl.
   the 5GFSFX0Q graft path), get_context_inflation_report / get_cache_break_report (workspace
   scans), conversation/history drills on 15k-line transcripts.
2. Get a NAMED profile: boot with `node --cpu-prof` (or SIGUSR1 inspector attach at the next
   wedge) and reproduce by replaying the drill traffic; or add per-request duration logging on
   the drill routes (cheap, permanent) so the wedge names itself.
3. Fix at the right altitude — TWO layers, both required:
   a. **Bound per-request work** (caps + async yields or worker_threads for corpus-sized drills):
      no HTTP handler may run unbounded synchronous O(corpus) work on the event loop.
   b. **Event-loop watchdog + self-heal**: monitor loop lag in-process; on sustained starvation
      (>N s) log the offender state and exit non-zero so the supervisor restarts — a wedged
      observability server is worse than a restarted one (and the ai-maestro guardian
      integration now DEPENDS on this CLI's availability).
4. Only after (2) names a genuinely compute-bound kernel: apply the USER's standing directive —
   a targeted **Rust helper** (napi-rs module or sidecar) for that measured hot path. A full
   Rust rewrite is NOT the fix for this bug: the defect is unbounded synchronous work on a
   single event loop — an architecture error that a faster language merely postpones; bounding +
   watchdog + worker isolation fix it in any language, and Rust is reserved for kernels that
   remain hot AFTER they are bounded.

(Superseded 14:10 addendum, kept for lineage:)

**✅ FIXED + MEASURED + LIVE-PROVEN (commit 3b1520a, 2026-07-14) — this addendum supersedes the
07-13 block below, whose NEXT ACTION list is DONE/OBSOLETE.** The 07-13 hypothesis (the 4s
tickBurn rebuild) was REFUTED by a cpu-prof capture: `buildSessionSummary()` was only 289 ms
(7.2% duty). The real causes, all fixed:
1. `buildUpdatePayload()` rebuilt the whole dashboard model on a 1-SECOND debounce with nothing
   cached → now 4s + version-keyed memo (`src/derivedCache.ts` `VersionedCache`, keyed on the
   `dataVersion` counter bumped at every mutation point; summary/stripped/sidebar/analytics all
   share one rebuild per actual data change).
2. `runLogScan()` full readdir+stat of ~12.5k files every 5s AND per fs.watch event → targeted
   watcher-driven scans + 60s full-sweep backstop (+ fast-poll fallback when no watcher attaches).
3. Scratch-tree walk re-listed the whole dir per append → mtime-gated.
Measured: CPU 17.1%→3.0% (1 writer), 28.8%→8.2% (4 writers). Regression guards:
`src/test/derivedCache.test.ts` (7 tests pin the memo semantics incl. reference identity +
fail-fast) and `getLogScanStats()` counters (incrementalReads/fullReads/filesStatted) make a
full-sweep regression observable. Live proof: 2026-07-16 server up 2h24m+ at real corpus
(451k stored spans / 17.3k cards), every request instant all day — the original hang developed
at 40 min. Column → ai_review (human review is the remaining gate).

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
- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113227+0200-batchB-server-ingestion.md
