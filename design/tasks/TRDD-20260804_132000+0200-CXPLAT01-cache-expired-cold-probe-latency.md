---
trdd-id: CXPLAT01
title: cache-expired intermittently takes 20-40s because the newest-session probe reparses the biggest transcript
column: todo
created: 2026-08-04T13:20:00+0200
updated: 2026-08-04T13:20:00+0200
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

## Notes and lessons learned

## Approval log
- 2026-08-04 — found while verifying the owner's question "are you sure the command can determine if
  a cache is expired without consuming tokens?". The token answer is yes (zero, proven); the
  measurement that proved it surfaced this latency defect. Filed at todo — the fix touches the
  server's bounded-scan design, which the owner should approve before it is changed.
