---
trdd-id: CXPLAT01
title: cache-expired intermittently takes 20-40s because the newest-session probe reparses the biggest transcript
column: published
created: 2026-08-04T13:20:00+0200
updated: 2026-08-18T16:25:43+0200
implementation-commits: [cd4f86f]
current-owner: claude-code
task-type: bugfix
severity: MEDIUM
labels: [cli, latency, hot-path, mcp]
relevant-files: [src/mcpServer.ts, src/cli/cacheExpiredCli.ts, src/agentGate.ts]
release-via: publish
---

# `cache-expired` intermittently costs 20-40 seconds

## The measurement (2026-08-04, live, this machine)

Timed through the bare PATH command, exit code and stdout captured each time:

| call | exit | seconds | stdout |
|---|---|---|---|
| 1 | 0 | **38.38** | false |
| 2 | 0 | **19.55** | false |
| 3 | 0 | 0.08 | false |
| 4 | 0 | 0.08 | false |
| 5 | 0 | 0.09 | false |

Bursts show the same shape amortised: 20 back-to-back calls took 71.6s (3.58s each),
50 calls took 252s. `last-compact`, which reads only the hook store off disk, is a flat
**0.42s** — so the cost is not process startup, it is the server-side probe.

## Cause (read first-hand, not inferred)

`handleCheckCacheExpiry`'s default path ranks cards by the cheap `lastActivityMs`, then
**reparses the top `EXPIRY_NEWEST_PROBE` (12) transcripts** to precision-rank them by their real
last `api_request`. `DRILL_SCAN_TIME_BUDGET_MS` bounds the scan BETWEEN items, so a single
synchronous reparse of one very large transcript is not bounded at all — and the card most likely
to be reparsed is, by construction, the most active session, i.e. the one with the biggest
transcript. Reparsed timelines are cached on the card, which is why calls 3-5 are instant; the
cache is invalidated as the session keeps writing, so the cost recurs all day on an active machine.

**This is not a token cost.** Verified separately: no LLM endpoint is reachable from this path (the
`api.anthropic.com` strings in the bundle belong to `subscriptionUsage.ts` oauth metadata and
`exactTokens.ts` count_tokens, neither on this path). It is wall-clock only. But a heartbeat-driven
caller that blocks 38s is a real problem, and it is exactly the shape TRDD-E8XIC2PM (the CLI latency
guard, `todo`) exists to catch.

## Proposed fix (decide before implementing)

The precise last-request time does NOT require a full transcript reparse. `agentGate.
readTranscriptContext` already answers the same question from a **bounded tail read** (256 KB, the
last assistant entry's `usage`), and it is what the burn gate uses on the PreToolUse hot path.

1. Give the expiry probe a cheap last-request resolver: bounded tail read per candidate, falling
   back to the full reparse only when the tail yields nothing.
2. Bound the per-item work as well as the between-item budget, so one pathological transcript can
   never dominate the call.
3. Pin it with a test that fails on a synthetic oversized transcript (the current suite pins the
   ITEM COUNT bound, which is why this slipped through).

Derived task: `last-compact` is unaffected (0.42s, disk only) but should get the same latency
assertion once a guard exists, so a future change cannot silently regress it.

## Re-verified 2026-08-05 — still live, and the diagnosis sharpens in the owner's favour

Nothing here changes a line of code; it is the evidence the approval gate below was waiting on.

**1. The defect is still live, same shape.** Five bare-PATH calls, timed:

| call | exit | seconds | stdout |
|---|---|---|---|
| 1 | 0 | **28.73** | false |
| 2 | 0 | **7.88** | false |
| 3 | 0 | 0.14 | false |
| 4 | 0 | 0.06 | false |
| 5 | 0 | 0.05 | false |

**2. The budget cannot bound the call even in principle — read first-hand at `scanWithBudget`
(`src/mcpServer.ts:3022`).** The deadline is checked **before** each item and never during one:

```js
for (const item of pool) {
  if (Date.now() > deadline) { stoppedEarly = true; break }
  results.push(await perItem(item))          // ← unbounded; nothing interrupts it
```

So the FIRST item always runs to completion no matter how long it takes — at t=0 the deadline has
by construction not passed. `DRILL_SCAN_TIME_BUDGET_MS` bounds *how many* items are attempted, never
*how long* one takes. The card's "not bounded at all" was right; the reason it can never be fixed by
tuning the budget is this.

**3. The pool here is ENTIRELY under the cap, so the cap is not what is protecting anyone.**
`cache-expired` self-scopes to the cwd (`src/cli/cacheExpiredCli.ts`), and this project has **6**
transcripts against an `EXPIRY_NEWEST_PROBE` of 12. A cold call therefore reparses **all six —
163.6 MB of JSONL, synchronously, in one request**:

| MB | transcript |
|---:|---|
| 64.4 | `a0fce09a…` |
| 61.9 | `7877ae1f…` |
| 17.6 | `667293ab…` |
| 7.9 | `d21b4c52…` |
| 7.7 | `c9ae7481…` (this session) |
| 4.1 | `66a730b3…` |

That reframes the fix: the item-count cap is doing nothing here, so **step 2 (bound the per-item
work) is the load-bearing half**, not step 1's candidate list.

**4. The proposed cheap resolver EXISTS and is genuinely bounded** —
`agentGate.readTranscriptContext(transcriptPath, now, tailBytes = 262_144)` (`src/agentGate.ts:156`).
At 256 KB × 6 candidates the probe would parse **~1.5 MB instead of 163.6 MB — a ~109× reduction in
bytes read**, and the datum it needs (the last assistant entry's `usage`) is at the END of the file,
which is exactly what a tail read is good at. The card's own fallback ("full reparse only when the
tail yields nothing") is the right guard: a 256 KB tail can legitimately contain no `api_request` if
the final entry is one huge tool result.

**Why no test was added yet, deliberately.** Step 3 asks for a test that FAILS on a synthetic
oversized transcript. Such a test asserts behaviour that does not exist yet, so committing it would
leave the suite red and CI blocked — a test for a fix belongs in the same change as the fix. It is
written the moment step 1/2 are approved, and it must be falsified against the pre-fix code (pin the
elapsed time with a `perItem` that blocks synchronously past the budget; today that call runs long,
after the fix it must not).

**STILL GATED on the owner** — steps 1 and 2 change the server's bounded-scan design, which the
Approval log below reserves for a human. This section only makes that decision better-informed.

## Notes and lessons learned

## Approval log
- 2026-08-04 — found while verifying the owner's question "are you sure the command can determine if
  a cache is expired without consuming tokens?". The token answer is yes (zero, proven); the
  measurement that proved it surfaced this latency defect. Filed at todo — the fix touches the
  server's bounded-scan design, which the owner should approve before it is changed.
- 2026-08-05 — Column `todo` → `human_review`. No work was done or undone; this corrects the column
  to match what the entry above already says. That entry reserves steps 1-2 for the owner, and
  step 3's test asserts behaviour that does not exist yet (committing it would leave the suite red),
  so **there is nothing here an agent can pick up** — and `todo` advertises exactly that. Same
  correction applied to TRDD-06Q5AXYN in this session, for the same reason and by the same standard:
  a column that overstates AVAILABILITY hides a card awaiting a human just as effectively as `dev`
  hides a stall. The evidence the decision needs was added earlier today and is unchanged.
- 2026-08-18T13:05:00+0200 — APPROVED by USER (batch "complete all TRDD" directive — the owner
  gate above is thereby released) and IMPLEMENTED in cd4f86f. Steps 1+2 shipped as designed: the
  probe ranks by a bounded 256KB tail read (`readTranscriptContext.lastRequestAtMs` +
  `LogReader.transcriptPathFor`), a tail miss ranks by card activity metadata, and the winner's
  verdict reuses the probed timestamp — at most ONE fallback reparse per call. Step 3's test was
  written with the fix and FALSIFIED against the resolver-less path (7 reparses/2100ms pre-fix vs
  0/14ms). Live after a full server restart: cold probe 2.29s (was 20-40s), warm 0.05s. Column →
  complete; rides the next publish (release-via: publish).
- 2026-08-18T16:25:43+0200 — PUBLISHED as agentlenspro@2.28.0 (tag v2.28.0, run 32147873962, OIDC
  trusted publisher + SLSA provenance verified on the registry). Release decision delegated by
  USER ("decide by yourself"). Archived as published.
