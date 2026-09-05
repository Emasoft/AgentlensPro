---
trdd-id: MVR6PXC0
title: Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure
column: todo
created: 2026-09-05T12:33:51+0200
updated: 2026-09-05T12:33:51+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: QE114936
related: [QE114936, UTFVMVT8, 2R36W8Q1]
---

# Three MCP tool handlers hold the state lock for one to four seconds inside their per-candidate resolve_session_card closure

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T12:33:51+0200

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
