---
trdd-id: 2YP3DB9Y
title: The server OOMs and dies, preceded by thousands of summarizeSpans stack overflows
column: completed
created: 2026-08-05T02:47:59+0200
updated: 2026-08-18T12:45:00+0200
implementation-commits: [9da7609]
current-owner: session
task-type: bugfix
relevant-rules: []
npt: []
eht: []
---

# The server OOMs and dies, preceded by thousands of summarizeSpans stack overflows

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body)

**STACK OVERFLOW: ROOT-CAUSED AND FIXED (`9da7609`). OOM: expected to follow, NOT yet proven.**

**Root cause — `Math.max(...xs)` past V8's max-arguments limit.** `src/summarizers/codex.ts` did
`Math.max(...allEndTimes)` inside `buildCodexSessions`' per-trace map, so the array was one trace
group's spans: unbounded. A spread passes every element as an ARGUMENT, and past ~125k that throws
exactly `RangeError: Maximum call stack size exceeded`.

**What turned the guess into a location:** the live log's stack named the frame directly —
`server.js:11349 ← Array.map ← buildCodexSessions ← summarizeSpans ← computeSessionSummary ←
buildSessionSummary ← buildUpdatePayload ← pushUpdate ← tickBurn`. So it fires from the **dashboard
push every 4 s**, not from a user request, which is why it accumulated continuously.

**Fixed at all four sites**, not just the one in the stack: `codex.ts` (now the shared, named
`maxOrDefault`), `claude.ts` ×2 (`timeline.push(...)` / `backgroundSpans.push(...)` on a merged
session), `copilot.ts` (`stack.push(...children)`).

**VERIFIED LIVE:** the count had grown 3,579 → **4,238** while the card sat here (~45 min). After
deploying the fix: **0 new in 45 s**, with the tick running every 4 s (~11 opportunities).

**Still open, and deliberately not claimed:** no OOM has occurred since, but two crashes took hours
to build, so "the heap exhaustion is gone" is NOT established — it is only the most likely
consequence of removing a 4-second error storm. Re-check `grep -c 'FATAL ERROR' ~/.agentlens/server.log`
after a long run (it stood at **2**).

**The lesson worth keeping:** `capacityCalibration.ts:145` ALREADY documents this exact hazard
("reduce, not `Math.min(...spread)` … V8's max-arguments limit → RangeError"). The knowledge was in
the codebase and never reached these four sites — which is why the fix is a shared named function
carrying the evidence, rather than a fourth inline loop.

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

- [x] The stack overflow is reproduced deterministically (a fixture span set, not the live store).
      (CLOSED 2026-08-14 — src/test/summarizerSpreadLimit.test.ts's premise test proves
      `Math.max(...xs)` throws at the fixture size, deterministically, no live store involved.)
- [ ] Root cause named for BOTH symptoms, or evidence that one causes the other.
      (RE-SCOPED 2026-08-14: the stack-overflow root cause is named and fixed (9da7609,
      maxOrDefault); the server's OOM class was independently root-caused and fixed under
      TRDD-QK3L5QAS (loadRange materialization) + TRDD-34B9JAZK/9NAUEUUR (span-walk
      parse-then-discard churn, measured). Whether THESE crashes' OOM half was the same mechanism
      is honestly unprovable post-hoc — recorded as such, not claimed.)
- [x] A fix with a regression test that FAILS against the current code.
      (CLOSED 2026-08-14 — summarizerSpreadLimit.test.ts pins maxOrDefault against the exact
      failure; the premise test doubles as the falsification: the raw spread throws at that size.)
- [ ] `summarizeSpans` bounded so a pathological span set degrades (drops/labels) instead of killing
      the process — an observability server that dies under load is blind exactly when it is needed.
- [ ] Consider whether the 1440m in-memory window is the right default at this ingest rate.

## Notes and lessons learned

The server is the thing that answers "what is burning" — it went down during an active burn
investigation on this machine and nothing announced it. Whatever the fix, a crash-loop needs to be
visible without reading a 12 MB log.

## Approval log

- 2026-08-14T02:48:00+0200 — COMPLETED (human_review → complete), re-scoped under the owner's
  standing review delegation. Done within this card: the stack-overflow half (root cause, fix
  9da7609, deterministic repro + falsifying regression in summarizerSpreadLimit.test.ts). The OOM
  class was root-caused and fixed under TRDD-QK3L5QAS + TRDD-34B9JAZK/9NAUEUUR with measured
  evidence. TRANSFERRED to TRDD-SUMSPANRE (in flight — the overflow RECURRED 2026-08-13 via a
  further spread site): bounding `summarizeSpans` so pathological input degrades instead of
  erroring, and reconsidering the 1440m in-memory window default. Nothing dropped; the two
  unchecked boxes above are those transferred items.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/summarizers/codex.ts:30 exports maxOrDefault, used at line 289.
