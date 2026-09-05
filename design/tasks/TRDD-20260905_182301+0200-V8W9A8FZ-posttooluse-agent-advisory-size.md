---
trdd-id: V8W9A8FZ
title: The PostToolUse Agent advisory is larger than it needs to be
column: backburner
created: 2026-09-05T18:23:01+0200
updated: 2026-09-05T18:23:01+0200
current-owner: main-session
task-type: refactor
priority: low
min-approval-requirement: none
scope: project
project-id: agentlenspro
created-by: 0Y8BMVK2
related: [0Y8BMVK2]
relevant-files: [src/agentGate.ts, rust-core/crates/agentlens-core/src/burn/agent_gate.rs]
review-after: 2026-10-05
---

# The PostToolUse Agent advisory is larger than it needs to be

Folded out of TRDD-0Y8BMVK2's 2026-09-03 STATE, which named "PostToolUse:Agent advisory size" as
one of two remaining items to card and carried no further specification. This card exists so the
remark is not lost; it has no measurement yet.

**What is known:** the burn-gate's `PostToolUse` path on `Agent` emits an advisory — the "notify
the MODEL" channel at `src/agentGate.ts:577` (TS twin; the Rust twin is
`rust-core/crates/agentlens-core/src/burn/agent_gate.rs`, which alcore serves live) — whose text
rides forward in the parent transcript on every later turn, so its size is a resident cost, not a
one-off (the cost model in CLAUDE.md, doctrine 7). The 2026-09-03
session judged it oversized while measuring the dashboard's cache attribution; the judgement was
not written down with a number.

**NEXT ACTION (when pulled):** measure first — capture one advisory from a live transcript, count
its tokens with `agentlenspro ctxmap` or the `count_tokens` route, and multiply by the number of
turns it survives in a typical session. Only then decide whether to shorten it, and by how much. A
card with no number is not a mandate to shrink anything.

## Acceptance

- [ ] One measured advisory size (tokens) and its per-session resident cost recorded here.
- [ ] Decision recorded: shorten (with the target size and what is dropped) or leave as is.

## Notes and lessons learned
