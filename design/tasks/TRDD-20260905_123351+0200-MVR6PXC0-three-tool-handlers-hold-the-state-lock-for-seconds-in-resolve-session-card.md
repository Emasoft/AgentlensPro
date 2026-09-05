---
trdd-id: MVR6PXC0
title: Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure
column: dev
created: 2026-09-05T12:33:51+0200
updated: 2026-09-05T17:16:41+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: QE114936
related: [QE114936, UTFVMVT8, 2R36W8Q1]
---

# Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T17:16:41+0200

**IN `dev` — the code is written and UNCOMMITTED in the working tree (`ui.rs` +149/−42); the full
cargo test run is the gate that has not passed.** The kraken worker spawned ~13:00 was stopped by the
orchestrator at 17:14 after 4 h with no reply to a 14:07 status ping and a transcript file untouched
since 13:50. That silence was NOT death: a subagent's transcript file does not grow while one Bash
call blocks, and `target/debug/deps` test binaries carried 16:51 mtimes — its suite was still
compiling 23 min before the stop, so the stop traded a possibly-imminent green for a fresh run.
Its final status on kill: `resolve_session_card` split into 5 shared helpers plus a new
`resolve_session_card_offlock` (the reparse runs OFF the lock, three short guards), all four closures
converted (`get_cost_by_cause`, `get_cache_risk_costs`, `get_cache_break_report`,
`check_cache_expiry`) with TRDD comments; `cargo build` 0, `cargo clippy --all-targets -D warnings` 0,
fixtures unchanged; `cargo test -p agentlens-core` had not completed under load-avg 40–160 (an earlier
run was OOM-killed, exit 137 — not a test failure). The diff is still in the working tree; a
belt-and-braces copy sits at `reports_dev/mvr6pxc0-kraken-ui-rs-20260905_1714.patch` (243 lines,
5 hunks). The split is INTENDED as behaviour-preserving (the worker's evidence: fixtures unchanged,
build and clippy 0); the full suite is the proof and is running as of 17:15. **NEXT ACTION:** read
that run's exit code from its capture file (`reports_dev/mvr6pxc0-cargo-test-20260905_1715.txt`);
if the machine is loaded again, run `--test ui` plus the touched-module tests first rather than
waiting hours on the full suite. On green, commit `ui.rs` by name citing this card; then deploy
(release build → `bin-native/darwin-arm64/alcore` → `codesign -s - --force` → `agentlenspro server
restart`) and re-run the 24-invocation recipe from the QE114936 box-3 report for the acceptance line.
On red, read the failure in full before touching the diff.

**Previous STATE (12:58) — IN `dev`.** Analysis done, read-only (`reports/mvr6pxc0/20260905_125347+0200-lock-scope-analysis.md`,
every element ✓ VERIFIED from source): the closures hold the guard across `resolve_session_card`'s
reparse-on-demand fallback, `log_reader::reparse_session(&Env, …)`, which needs no state and does
disk I/O + JSONL parsing of a multi-MB transcript; only `put_log_session` (an IndexMap insert),
the summary lookup and `graft_otel_attribution` need the guard. A fourth site shares the shape.
The fix is UTFVMVT8's snapshot-then-work split; a worker is implementing it with build, clippy
and the full cargo test set, parity goldens required unchanged. Then: deploy (release build →
`bin-native/` → `codesign -s - --force` → `agentlenspro server restart`) and re-run the
24-invocation recipe from the QE114936 box-3 report for the acceptance line.

Found by TRDD-QE114936's acceptance box 3 (invoke every rewritten tool once while ingest is
hot: `reports/qe114936/20260905_123046+0200-box3-tool-invocations.md`). The twenty
summary-rebuild sites that card fixed are clean — no `state lock held ≥ 1000 ms` at any
`summary_now` site over 24 invocations. But three handlers still log holds of 1,037–3,948 ms,
eight lines in one window, all inside their `timeline_of` closure that calls
`resolve_session_card` per candidate:

| ms | site | tool |
|---|---|---|
| 1475 | `ui.rs:2074` | `get_cost_by_cause` |
| 1272, 1387, 1234, 2931, 3948 | `ui.rs:3220` | `get_cache_risk_costs` |
| 1037, 1274 | `ui.rs:3283` | `get_cache_break_report` |

QE114936's STATE already carried this as "the reparse in `resolve_session_card` can still block
a tokio worker thread" — a known remaining cost, not the defect that card targets. It gets its own
card because a 4 s hold under the state lock blocks every ingest and every other handler for
that long, on a server many Claude Code sessions post to concurrently (the goal: never lose
data).

**NEXT ACTION:** read `ui.rs:2074`, `:3220`, `:3283` and `resolve_session_card`; establish
whether the closure does I/O or a transcript reparse under the lock (the lock should be taken
only to snapshot the candidate list, and the per-candidate work done outside it, as
UTFVMVT8 did for the composition routes). Measure again with the same 24-invocation recipe
after the change; the box is the absence of any `≥ 1000 ms by ui.rs:<site>` line for these
three tools.

## Acceptance

- [ ] The three handlers take the state lock only to snapshot, and `resolve_session_card` runs
      outside it (or is proven lock-free).
- [ ] Same 24-invocation recipe as the QE114936 box-3 report: zero `state lock held ≥ 1000 ms
      by ui.rs:{2074,3220,3283}` lines while ingest is hot.
- [ ] QE114936's box 3 note updated to point here.

## Notes and lessons learned
