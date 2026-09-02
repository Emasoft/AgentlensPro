---
trdd-id: UTFVMVT8
title: The composition routes hold the state lock for seconds at ui.rs:560 and the dominant statement is not yet isolated
column: dev
created: 2026-09-02T12:55:49+0200
updated: 2026-09-02T16:46:41+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
parent-trdd: 2R36W8Q1
related: [2R36W8Q1, 768NEX6E, L6V1UUW0, QE114936]
---

# The composition routes hold the state lock for seconds at ui.rs:560 and the dominant statement is not yet isolated

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured by the lock attribution TRDD-2R36W8Q1 landed (15 min after the 12:52 deploy, pid 26060,
  under the sessions already running — no soak):** 33 `state lock held` lines; the top twelve are ALL
  `ui.rs:560` — **74,709 ms, 34,793, 27,155, 17,944, 15,620, 14,919, 13,719, 13,362, 6,853, 5,512,
  5,336, 5,253 ms** — then `ui.rs:534` at 3,936 ms. 84 waiters queued behind them: the log sweeper
  for 72,944 ms (`log_reader.rs:1052`), the OTLP ingest handler 8,842 ms (`lib.rs:918`), the span
  flush tick 8,842 ms (`chores.rs:561`), the summary rebuild task 8,768 ms (`ui.rs:212`), the
  data-version poller 8,871 ms (`ui.rs:3787`). Three bodies passes in the same window ran 55–141 s
  instead of 14–23 s (TRDD-768NEX6E) — CPU contention from the same holds is INFERRED from
  co-occurrence, not measured. A read path and a write path stalling together on ONE holder is
  exactly the shape 2R36W8Q1's STATE predicted.
- **Still holding on the redeployed pid 53886 alone (log from its boot marker, `server.log` line
  497616, 1h14m to 14:28):** 104 `held` lines, **82 at `ui.rs:560`** — 16 of them ≥ 10 s (10.9, 11.0,
  13.6, 15.2, 18.5, 19.9, 20.9, 23.0, 26.1, 31.3, 31.6, 33.5, 54.1, 55.9, 62.2 and **273.9 s**) and a
  floor of 2.2–3.0 s on most of the rest. Behind the 274 s hold a reader at `ui.rs:265` waited
  273,887 ms and the log sweeper 29,555 ms. The log carries no timestamps, so the partition is by
  boot marker, not by time.
- **A SECOND multi-second holder, `ui.rs:3200` (read 15:50, all 29 non-560 holds on the pid listed,
  not a `head` preview — review-fork finding):** 2,261 / 3,756 / 6,219 / **10,175 ms**. It is the
  last-request resolver's guard, which runs `st.build_session_summary(now)` under the lock and then
  deep-clones EVERY session card (`summary.get("sessions")…cloned()`) before releasing — the same
  shape as 560 minus the scope resolution, so it is a second acceptance target here, not a new
  card. Every other site on the pid is ≤ 1,250 ms (`log_reader.rs:1052` once; the rest < 1 s).
  `chores.rs:653` (the hook-spool drain tick) has NO `held` line at all: the 26,280 ms wait at
  `ui.rs:265` that named it as holder "for 0 ms when we queued" was queued the instant 653 acquired,
  653 released under the 250 ms threshold, and the wait was served behind whoever acquired next —
  the holder slot names the holder AT QUEUE TIME, not the site the waiter actually waited behind.
- **Box 1 instrumentation DEPLOYED 16:03:43 as pid 6978 (built, clippy-clean, lib tests 37/37,
  symbol verified in the shipped binary):** `compositions_in_scope` times its three statements and
  prints `alcore: compositions_in_scope guard split: project_map N ms, session_ids N ms (K ids),
  resolve_scope N ms` whenever the guard's total reaches `AGENTLENS_LOCK_TRACE_MS` (250) — the same
  threshold as the `held` line it sits next to. Read 15 min of `server.log` from that pid's boot
  marker (line 498622).
- **The holder SITE is proven; the dominant CALL is NOT (review-fork finding, settled by reading
  2026-09-02 14:25).** `ui.rs:560` is `compositions_in_scope`'s lock and `ui.rs:534` is
  `composition_for`'s. A `held` line names the guard, not what ran under it, and the 560 guard runs
  THREE statements: (1) `st.composition_project_map(now)` (`lib.rs:470`), whose first line is
  `self.build_session_summary(now_ms)` — which SHORT-CIRCUITS through `summary_cache.get(data_version,
  …)` (`derived_cache.rs:26`) whenever the version matches. How often THIS caller matches is NOT
  resolved by the live counters: `/api/debug/log-scan-stats` at 14:24 read summary hits 76,902 /
  misses 608 on pid 53886, but `current()` and `cached_any()` — the off-lock `rebuild_once` path —
  count hits and `store_if_newer()` counts misses too (`derived_cache.rs`), so the only bound is
  that inline `get()` rebuilds under this guard numbered ≤ 608 in 74 min, which still allows EVERY
  composition call to have missed (`data_version` bumped 29,632 times on this pid); (2) `st.bodies.session_ids()`
  collected into a `Vec<String>`; (3) `resolve_scope` over EVERY id with a per-id project closure.
  Those ids are the BODIES index (`st.bodies`), whose size has not been read — not the 27,689 log
  sessions `server status` reports, a different set. Which of the three carries the steady 2.3 s holds and the
  274 s outlier is unmeasured: a cache miss inside (1) is the natural suspect for the outliers and
  (2)+(3) for the steady holds, but that is inference — the earlier "built, discarded, and rebuilt
  on the next request" sentence overstated (1) and is retracted.
- **BOX 1 ANSWERED after 4 min on pid 6978 (16:07):** two traced holds, both 100 % in statement (1):
  `guard split: project_map 12584 ms, session_ids 0 ms (0 ids), resolve_scope 0 ms` next to
  `held 12585 ms by ui.rs:560`, and `project_map 30126 ms, session_ids 0 ms (2 ids), resolve_scope
  0 ms` next to `held 30127 ms`. The inline summary rebuild on a cache miss IS the hold; the bodies
  index is 0–2 ids, so (2) and (3) are nothing. The original attribution was right in substance and
  wrong in proof; now it is proven. **15-min read of pid 6978 (16:03–16:18): 19 traced holds at
  `compositions_in_scope`, EVERY one 100 % `project_map`** — 12.6, 30.1, 29.2, 26.1, 17.4, 13.1,
  9.4, 9.0, 7.7, 7.1, 7.2, 6.7, 6.2, 5.9, 10.8, 30.3, **82.0, 85.1, 67.3 s** — with `session_ids`
  0 ms (0–4 ids) and `resolve_scope` 0 ms on all 19; `composition_for` (534) held **110.2 s** once
  and the resolver's guard (3218) **64.5 s** once. Every other site ≤ 931 ms (every `held` line in
  the partition matched the extraction shape; 36 `held` / 20 `split` lines by 16:20). CAVEAT on the
  absolute numbers: two 5-min `cargo build --release` runs of mine (16:00–16:05, 16:10–16:20)
  overlapped this window, so the hold DURATIONS are inflated by CPU contention; the ATTRIBUTION
  (100 % `project_map` on every traced hold) does not depend on contention. The post-fix read
  must not overlap a build.
- **LINE NUMBERS ARE PER BINARY (review-fork finding):** the box-1 insert shifted every lock site
  after 560 by +18 in pid 6978's binary, so the second holder is `ui.rs:3200` on pid 53886 and
  `ui.rs:3218` on pid 6978 — the `check_cache_expiry` tool handler's guard either way. Key every
  read on the FUNCTION (`compositions_in_scope`, `composition_for`, `check_cache_expiry`), never on
  the number; the fix below shifts them again.
- **THE FIX IS IN THE CODE (16:08, pending build/clippy/tests/deploy):** `CoreState::composition_project_map`
  is gone; `agentlens_core::composition_project_map(summary: &Value)` is the same map as a pure
  function, and all three holders call `ui::summary_now` (off-lock: warm hit, else the freshest
  stale value with a bounded wait on the rebuilder, cold boot builds once) BEFORE taking the guard.
  `check_cache_expiry` also deep-clones the cards off the lock now (the fork's point: its 10 s could
  be the clone on a HIT, so the clone had to move too, not just the build). The split instrumentation
  is removed with the statement it measured. Eighteen more `st.build_session_summary(` sites inside
  the MCP tool dispatch keep the shape, unmeasured as holders → TRDD-QE114936.
- **Staleness consequence caught by the review fork before deploy (16:15):** the served summary can
  be one rebuild behind, so a session younger than one rebuild is ABSENT from it and resolves to
  `project: None`; the composition cache (`ContextCompositionIndex`, LRU 64, keyed on session id
  only, no `data_version`) would have pinned that as `project: "unknown"` until eviction — the
  P4x.2c failure this card's box 3 exists to catch. `composition_for` now serves such a build but
  does NOT cache it (`project_known` guard); the next call resolves against a newer summary. An
  orphan session whose card never appears re-parses its bodies on every call — acceptable, noted
  in code as the ceiling. Box 4 therefore needs a NEW-session probe, not only a steady-state one.
- **THE TRADE, stated as a trade and not denied (review-fork correction, 16:18):** the OLD path was
  always CURRENT — `VersionedCache::get` hits only on an exact `data_version` match, so any ingest
  since the last store rebuilt fresh, and that fresh rebuild under the lock IS the 12–110 s hold. The
  NEW path serves the snapshot the last COMPLETED rebuild started from, so its data age is up to
  about TWO rebuild durations (snapshot at the start of the last rebuild, plus one full rebuild until
  the next store lands) and it never holds. The rebuild duration on THIS machine is NOT milliseconds:
  the four quietest traced rebuilds (the 16:04–16:09 gap with no cargo running) measured **5.9, 6.2,
  6.7, 7.1 s** at 27.7k log sessions + 145k spans — the "milliseconds at normal sizes" in
  `summary_now`'s doc comment was written for a far smaller corpus (review-fork correction). Two
  accepted consequences, each bounded by that age: (a) a single-session composition for a session
  younger than it is served with `project: "unknown"` (uncached, corrected on the next call); (b)
  in `compositions_in_scope`, `resolve_scope` matches a project scope with
  `project_for(id).unwrap_or_default().starts_with(scope)`, so such a session is OMITTED from a
  project-scoped answer until the next rebuild — FULLY silently: the `coverage` text still reads
  "Scanned all N live-registry session(s) in scope". Neither has a guard beyond the rebuild cadence.
  "Fresh-but-blocking became stale-but-free" is the accurate sentence.
- **DEPLOYED 16:34:30 as pid 18695 (commit 428a1dec; build 0 / clippy 0 / lib tests 37/37; fresh
  inode, `codesign -v`; symbol check: the removed split string is absent from the shipped binary).**
  The stop of the pre-fix pid 6978 STARVED: SIGTERM at 16:28:37, still alive and HTTP-dead six
  minutes later, every tokio worker parked on the state mutex, and a 2 s `sample` finally caught
  the HOLDER BY STACK — one worker spent all 1,413 samples in `composition_project_map →
  build_session_summary → summary_over`, the exact call this card names. SIGKILLed 16:34:22; the
  shutdown defect is TRDD-N60JUWU3. CORRECTED (the first version here had the window an hour
  early): spans stored per minute fell from 0.8–2.6k to single digits at **16:12** — when this
  guard's holds reached 82/85/67 s and the OTLP handler waited 145 s — stayed near zero through
  16:42, and recovered only at **16:43**, nine minutes after the new binary was serving OTLP in
  0.5 ms. Thirty minutes of OTEL-only detail lost at the source (exporter timeouts and back-off,
  inferred from timing); the numbers are on N60JUWU3. LINE NUMBERS on pid 18695's binary:
  `composition_for` guards at `ui.rs:527` (cache get) / `543` (resolve_refs) / `562` (cache put),
  `compositions_in_scope` at `581`, the `check_cache_expiry` TTL guard at `3227`. Key the post-fix
  read on these, or on the function names.
- **Box 4 steady-state probes PASS on pid 18695 (16:37):** `GET /api/composition-index/<this
  session>` → 200 in 0.5 s with `project: /Users/…/AgentlensPro`; `query_context_blocks --project
  <this repo>` → "Scanned all 1 live-registry session(s) in scope", 564 blocks. The young-session
  probe is still owed.
- **What this card does NOT fix, on purpose:** inside the same `check_cache_expiry` handler the
  per-candidate `timeline_of` closure takes its own guard and calls `resolve_session_card` →
  `st.build_session_summary` (`ui.rs:599` at this commit) — a rebuild under the lock per candidate
  on every miss, logged under the closure's line, not the handler's. Whether that happens in
  practice is a HYPOTHESIS from the bump rate (~6.7/s): no `held` line at the closure's site
  appeared in any measured window, only at the handler's own guard. It is TRDD-QE114936's site 599
  either way. Box 3 below is scoped to the handler's OWN guard, and says so.
- **NEXT ACTION:** build (`cargo build --release -p agentlens-core --bin alcore`), clippy, lib tests;
  deploy fresh-inode; read 15 min of `server.log` from the new pid's boot marker: acceptance is NO
  `state lock held ≥ 1000 ms by ui.rs:<compositions_in_scope | composition_for | check_cache_expiry>`
  and the disappearance of the multi-second waits at the sweeper/ingest sites.

## Acceptance

- [x] Per-statement timing inside `compositions_in_scope`'s guard (`ui.rs:560`) — map / ids /
      resolve_scope — is logged on every traced hold, deployed, and names the dominant statement
      from numbers, not from source reading. DONE 16:07 on pid 6978: 100 % `project_map`
      (12,584 and 30,126 ms), 0 ms for the other two, 0–2 ids.
- [ ] `composition_project_map` (or its callers) no longer calls `build_session_summary` under the
      state lock; the map comes from the summary cache or an off-lock build. IN CODE 16:08
      (`summary_now` before the guard, pure `composition_project_map(&summary)`); box closes on the
      deploy read.
- [ ] After deploy, 15 min of `server.log` under normal load shows no `state lock held ≥ 1000 ms`
      line by `compositions_in_scope`, `composition_for`, or the `check_cache_expiry` handler's
      OWN guard (`ui.rs:3200` on pid 53886, `ui.rs:3218` on pid 6978 — key on the function, the
      number shifts per binary), the second holder of the same shape. The handler's per-candidate
      `timeline_of` guard (site 599) is TRDD-QE114936's, not this box's.
- [ ] `/api/context-compositions` (scoped and single-session) still fills `project` — the P4x.2c
      parity note on `composition_project_map` explains why a wrong map answers 200 with nothing.
      Probe BOTH a steady-state session AND a session started after the last rebuild: the second
      must answer `project` correctly on a later call, not stay `"unknown"` (the uncached-build
      guard above), and a project-scoped query must include it once the next rebuild has landed
      (the accepted `resolve_scope` omission above is bounded, not permanent).

## Notes and lessons learned

- Empty section on creation.
