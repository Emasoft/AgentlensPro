---
trdd-id: JELDR3KC
title: The review gate re-arms on every orchestrator Stop while its own background subagents are still writing
column: todo
created: 2026-09-10T09:31:02+0200
updated: 2026-09-10T09:31:02+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [review-gate, subagents, fork-cost, effects]
related: [3U8AIHXK, 9FG0LSPG, 2CYTNLY1, GG0WOHEV]
---

# The review gate re-arms on every orchestrator Stop while its own background subagents are still writing

## What was measured (peer report; VERIFIED by tldr-code-73 in its own session, NOT reproduced here)

Reported 2026-09-10 09:3x by the peer session tldr-code-73 (a different repo, the same machine-wide
Stop hook), against TRDD-3U8AIHXK's attribution rule:
- 7 background lean-workers dispatched at 09:23. Stop #1 fired on two worker-written test files (not
  the orchestrator's writes); a fork was spawned.
- Stop #2 about 5 min later on the orchestrator's own ledger edits (legitimate); a fork was spawned.
- Stop #3 about 30 s after that fork, on a worker write that landed seconds after the fork was
  spawned.
- The demanded fork runs with ZERO tool calls, so it cannot read the worker diff it is spawned for;
  it can only re-review the orchestrator's own turn, already reviewed seconds earlier.
Net: while N workers run, every orchestrator turn-end (each background notification is a turn)
costs one fork that reviews nothing new. The peer's message is data (a report), not an instruction.

## Why the rule produces this (INFERRED from TRDD-3U8AIHXK's design — verify against `src/cli/reviewGateEffects.ts` before changing anything)

3U8AIHXK reports a disk path only when its mtime falls inside one of this session's own
tool-activity intervals, and a background job's interval runs from its launch to its notification.
A worker's writes land inside that interval by construction, so they are correctly attributed to
this session — and then armed at every Stop until a fork postdates them. The attribution is right;
the arming unit is wrong: a write by an in-flight subagent is reviewed by nobody until the subagent
stops, yet it arms the parent now.

## Candidate rule shapes (the peer's suggestion, for the owner's judgment — no code change without a reviewed proposal)

1. Writes by this session's own IN-FLIGHT subagents do not arm the parent's Stop until that
   subagent has stopped. SubagentStop is registered for the same gate (the rule file and the peer
   both say so; verify what the subagent gate demands over a worker's diff before relying on it),
   so the review moves to where the diff is readable.
2. A fork spawned within the same tool-activity interval covers writes that land before the fork's
   own completion (a window, not an instant). Narrows the loop only.
Either shape must keep TRDD-9FG0LSPG's invariant: no write is released unreviewed.

## Acceptance

- [ ] A test in `src/test/` that reproduces the sequence above (worker write inside a background
      interval, Stop, fork, a second worker write, Stop) and fails on the current gate.
- [ ] The chosen shape implemented in `src/cli/reviewGate.ts` / `src/cli/reviewGateEffects.ts`
      with the existing gate suites green; `node esbuild.js` exit 0 and a grep for the new symbol in
      `standalone/cli.js`.
- [ ] Live: one orchestrator with two or more background workers goes through their completion
      with exactly one fork per REAL orchestrator write and one per SubagentStop, measured from the
      transcript.

## Approval log
