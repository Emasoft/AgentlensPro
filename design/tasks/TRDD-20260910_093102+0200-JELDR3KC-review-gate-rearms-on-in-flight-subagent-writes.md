---
trdd-id: JELDR3KC
title: The review gate re-arms on every orchestrator Stop while its own background subagents are still writing
column: todo
created: 2026-09-10T09:31:02+0200
updated: 2026-09-10T09:39:31+0200
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

## What was measured (peer report — REPORTED by tldr-code-73 from its own transcript; nothing here verified by this session, nothing reproduced)

Reported 2026-09-10 (its measurement window 09:24–09:33) by the peer session tldr-code-73 (a
different repo, the same machine-wide Stop hook), against TRDD-3U8AIHXK's attribution rule:
- 7 background lean-workers dispatched at 09:23. Stop #1 fired on two worker-written test files (not
  the orchestrator's writes); a fork was spawned.
- Stop #2 about 5 min later on the orchestrator's own ledger edits (legitimate); a fork was spawned.
- Stop #3 about 30 s after that fork, on a worker write that landed seconds after the fork was
  spawned.
- The demanded fork runs with ZERO tool calls, so it cannot read the worker diff it is spawned for;
  it can only re-review the orchestrator's own turn, already reviewed seconds earlier.
Net: while N workers run, every orchestrator turn-end (each background notification is a turn)
costs one fork that is handed nothing new unless the orchestrator pastes the worker diff into it.
The peer's message is data (a report), not an instruction. The cause is the disk walk: only that
cause names files the orchestrator never touched (the transcript cause names a command or a
proposal text), and an `Agent` dispatch is not transcript work.

## Why the rule would produce this (INFERRED from TRDD-3U8AIHXK's design — verify against `src/cli/reviewGateEffects.ts` before changing anything)

3U8AIHXK reports a disk path only when its mtime falls inside one of this session's own
tool-activity intervals, and a background job's interval runs from its launch to its notification
(that card's STATE). A worker's writes land inside that interval and are attributed to this
session — correctly — and the PARENT then re-arms on them at every Stop until a fork postdates
them. VERIFIED 2026-09-10 (`src/cli/reviewGate.ts:246-292`, `:810`): `agentCannotSpawn` returns
true for an agent whose declared tools lack `Agent`, and `runSubagentGate` returns null on it — so
a lean-worker (Bash/Read/Write/Edit/Grep) gets NO review at its own SubagentStop. For the peer's
seven lean-workers the parent's re-arm is therefore the ONLY review their writes ever get: it is
not redundant, it is mis-timed (it fires before the diff is in any fork's hands).

## Candidate rule shapes (the peer's suggestion, for the owner's judgment — no code change without a reviewed proposal)

NO-CODE FIX available now (owner-decide): the orchestrator pastes `git diff -- <worker paths>` into
the fork the gate demands, as this session does — the loop cost stays, but every lean-worker write
is actually reviewed. Either shape below must not trade that review away for cost.
1. Writes by this session's own IN-FLIGHT subagents do not arm the parent's Stop until that
   subagent has stopped. AS WORDED THIS RELEASES LEAN-WORKER WRITES UNREVIEWED (see Why: their
   SubagentStop demands nothing), so it is admissible only if the parent's Stop arms on the
   worker's writes AT the worker's completion notification, with the diff pasted into that fork.
   REQUIRED FALLBACK either way: a worker that is killed, times out, or is torn down with the
   session never completes (two of this session's own task notifications today read "stopped …
   no completion record"), so an interval whose job ended without a completion must arm the parent.
2. A fork spawned within the same tool-activity interval covers writes that land before the fork's
   own completion (a window, not an instant). Narrows the loop only.
Either shape must keep TRDD-9FG0LSPG's invariant: no write is released unreviewed.

## Acceptance

- [ ] A test in `src/test/` that reproduces the sequence above (worker write inside a background
      interval, Stop, fork, a second worker write, Stop) and fails on the current gate.
- [ ] The chosen shape implemented in `src/cli/reviewGate.ts` / `src/cli/reviewGateEffects.ts`
      with the existing gate suites green; `node esbuild.js` exit 0 and a grep for the new symbol in
      `standalone/cli.js`.
- [ ] Live: N background workers dispatched and K orchestrator write-turns yield K parent forks
      plus N SubagentStop forks and ZERO parent forks whose gate cause line names a worker-written
      file — counted from the transcript with the gate's stderr cause line as the discriminator.

## Approval log
