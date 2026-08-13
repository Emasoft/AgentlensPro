---
trdd-id: SUMSPANRE
title: summarizeSpans hits Maximum call stack size exceeded on large span sets
column: backburner
created: 2026-08-13T12:57:16+0200
updated: 2026-08-13T12:57:16+0200
current-owner: agentlenspro-session
task-type: bugfix
---

Observed live 2026-08-13 (server.log, twice): "summarizeSpans error: RangeError: Maximum call stack size exceeded" on a store of ~5.35M spans / ~100k in-memory. Classic cause: a spread over a huge array (fn(...spans) / push(...spans) exceeds the argument-count stack limit). Find the spread in summarizeSpans' path and replace with a loop/reduce; add a test with an array larger than the V8 argument limit (~65k+) proving the summarize completes. The error is caught (server survives) but the affected summary silently degrades.
