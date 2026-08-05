---
trdd-id: 2YP3DB9Y
title: The server OOMs and dies, preceded by thousands of summarizeSpans stack overflows
column: todo
created: 2026-08-05T02:47:59+0200
updated: 2026-08-05T02:47:59+0200
current-owner: session
task-type: bugfix
relevant-rules: []
npt: []
eht: []
---

# The server OOMs and dies, preceded by thousands of summarizeSpans stack overflows

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body)

**FILED, NOT STARTED.** Found while auditing `src/cli` (TRDD-M8SV6LK5); this is server-side, so it is
its own card rather than scope creep. The server has been restarted and is healthy — the defect is
NOT resolved, only cleared.

## What happened, measured

The standalone server **died of OOM** while this session was using it:

```
[AgentLens] summarizeSpans error: RangeError: Maximum call stack size exceeded   (×3,579)
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

- **2 fatal OOM crashes** in the current `~/.agentlens/server.log` (lines 54164 and 270545).
- **3,579** `summarizeSpans error: RangeError: Maximum call stack size exceeded` lines, first at
  222635, last at 270528 — i.e. the stack overflows ran for ~48k log lines and the OOM followed them.
  The RangeError is caught and logged; the process keeps serving degraded until the heap goes.
- Scale at restart: **529,542 spans in memory** (1440m window), store 5,029.9 MB / 4,263,003 spans,
  `rss=3008MB heap=1947/6240MB`, 19,005 log sessions.

**Symptom as the user meets it:** every MCP-backed CLI verb fails with
`cannot reach http://localhost:4316/mcp: socket hang up`, while the disk-backed verbs
(`statusline-history`, `last-compact`, `cache-expired`) keep answering. That split is by design and
it worked — but it also means the failure presents as "one command is broken", not "the server died".

## Candidate causes — NOT established, do not treat as findings

`summarizeSpans` is `src/spanSummarizer.ts:33` (283 lines). Both symptoms have plausible sources
there, and they are different bugs; a fix must say which one it is fixing.

- **Stack overflow** — most likely a recursive walk (`childrenOf` / trace-tree assembly) going deep
  or cycling on a malformed parent chain. A cycle in `parentSpanId` would recurse forever, which fits
  a RangeError far better than any spread does.
- **Heap exhaustion** — `src/spanSummarizer.ts:200`
  `sess.backgroundSpans = [...(sess.backgroundSpans ?? []), ...bgByTraceId[sess.traceId]]` rebuilds a
  growing array inside a loop (quadratic allocation), and line 267 does the same. At half a million
  spans that is a real allocation storm. Note this is array-literal spread, which V8 implements with
  an iterator — so it is an OOM candidate, **not** a stack-overflow candidate.

**A timing hypothesis worth testing first, because it is cheap:** the crash landed immediately after
this session ran `get_cache_event_log`, a heavy query over the span store, and minutes after several
`investigate_burn` / `--risk` calls had succeeded. If a diagnostic query over a ~500k-span window is
what tips it, the reproducer is one command rather than a day of traffic.

## Acceptance

- [ ] The stack overflow is reproduced deterministically (a fixture span set, not the live store).
- [ ] Root cause named for BOTH symptoms, or evidence that one causes the other.
- [ ] A fix with a regression test that FAILS against the current code.
- [ ] `summarizeSpans` bounded so a pathological span set degrades (drops/labels) instead of killing
      the process — an observability server that dies under load is blind exactly when it is needed.
- [ ] Consider whether the 1440m in-memory window is the right default at this ingest rate.

## Notes and lessons learned

The server is the thing that answers "what is burning" — it went down during an active burn
investigation on this machine and nothing announced it. Whatever the fix, a crash-loop needs to be
visible without reading a 12 MB log.
