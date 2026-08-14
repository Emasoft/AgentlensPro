---
trdd-id: SUMSPANRE
title: summarizeSpans hits Maximum call stack size exceeded on large span sets
column: complete
created: 2026-08-13T12:57:16+0200
updated: 2026-08-14T03:10:00+0200
current-owner: agentlenspro-session
task-type: bugfix
---

Observed live 2026-08-13 (server.log, twice): "summarizeSpans error: RangeError: Maximum call stack size exceeded" on a store of ~5.35M spans / ~100k in-memory. Classic cause: a spread over a huge array (fn(...spans) / push(...spans) exceeds the argument-count stack limit). Find the spread in summarizeSpans' path and replace with a loop/reduce; add a test with an array larger than the V8 argument limit (~65k+) proving the summarize completes. The error is caught (server survives) but the affected summary silently degrades.

Also transferred here from TRDD-2YP3DB9Y at its close (2026-08-14): bounding `summarizeSpans` so a
pathological span set degrades (drops/labels) instead of erroring, and reconsidering the 1440m
in-memory window default — both remain open observations, not regressions.

## Approval log

- 2026-08-14T03:10:00+0200 — COMPLETED (backburner → complete). The exhaustive call-graph walk
  (reports/trdd-review/20260814_021721+0200-SUMSPANRE-fix.md) found ZERO remaining spread-into-call
  sites inside summarizeSpans' own path — all three (codex/claude/copilot) were already converted
  in 9da7609 — and added the end-to-end regression the unit tests lacked (buildCodexSessions over a
  200,001-span trace, 6/6 green). The one genuine remaining site of the same defect class was
  OUTSIDE the path: standalone/server.ts computeAnalyticsData's `Math.min/max(...times)` over up to
  ~100k session times, in the same tickBurn→pushUpdate cycle but outside the try/catch — the most
  plausible cause of the 2026-08-13 recurrence signature. Fixed as a bounded loop in the closing
  commit. The two transferred 2YP3DB9Y items above stay recorded as future hardening observations;
  neither has recurred since the analytics fix and neither blocks this card's own contract (find
  and fix the spread in the path — done and measured by tests).
