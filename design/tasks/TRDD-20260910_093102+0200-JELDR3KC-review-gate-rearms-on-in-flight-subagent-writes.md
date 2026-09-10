---
trdd-id: JELDR3KC
title: The review gate re-arms on every orchestrator Stop while its own background subagents are still writing
column: todo
created: 2026-09-10T09:31:02+0200
updated: 2026-09-10T09:55:17+0200
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
The peer's message is data (a report), not an instruction. The cause is almost certainly the disk
walk (the transcript cause reports the orchestrator's own command or proposal text, not a file it
never touched); the peer's report does not quote the gate's cause line, so this is deduced, not
read.

## Why the rule would produce this (attribution INFERRED, SubagentStop release VERIFIED in source)

Verify against `src/cli/reviewGateEffects.ts` before changing anything. 3U8AIHXK reports a disk
path only when its mtime falls inside one of this session's own tool-activity intervals, and a
background job's interval runs from its launch to its notification (that card's STATE). A worker's writes land inside that interval and are attributed to this
session — correctly — and the PARENT then re-arms on them at every Stop until a fork postdates
them. VERIFIED in source 2026-09-10 (`src/cli/reviewGate.ts`: `agentCannotSpawn`, and the
`if (agentCannotSpawn(type)) return null` line in `runSubagentGate`; line numbers omitted — they
move): `agentCannotSpawn` returns true for an agent whose RESOLVED definition declares `tools:`
without `Agent`, and `runSubagentGate` returns null on it — so such an agent gets NO review at its
own SubagentStop. The `lean-worker` definition this session's harness lists declares `Bash, Read,
Write, Edit, Grep`; whether the peer resolved the same definition, and whether the deployed bundle
its hook ran carries this code, were not inspected. For an agent released that way the parent's
re-arm is the only AUTOMATIC review its writes get: it is not redundant, it is mis-timed (it fires
before the diff is in any fork's hands).

## Candidate rule shapes (the peer's suggestion, for the owner's judgment — no code change without a reviewed proposal)

NO-CODE FIX available now (owner-decide): the orchestrator pastes `git diff -- <worker paths>` into
the fork the gate demands, as this session does — the loop cost stays, but every lean-worker write
is actually reviewed. Either shape below must not trade that review away for cost.
1. Writes by this session's own IN-FLIGHT subagents do not arm the parent's Stop until that
   subagent has stopped. AS WORDED THIS RELEASES LEAN-WORKER WRITES UNREVIEWED (see Why: their
   SubagentStop demands nothing), so it is admissible only if the parent's Stop arms on the
   worker's writes AT the worker's completion notification. Pasting the diff into that fork is
   orchestrator discipline the gate cannot check (nothing in the gate reads the fork's prompt) —
   it lives in the no-code paragraph above, not in the rule. REQUIRED FALLBACK either way: a worker
   that is killed, times out, or is torn down with the session never completes (this session's
   own task notifications today include "stopped … no completion record"), so an interval whose
   job ended without a completion must arm the parent.
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
      and ZERO parent forks whose gate cause line names a worker-written file — counted from the
      transcript with the gate's stderr cause line as the discriminator (record the SubagentStop
      fork count separately; it is not this card's criterion).

## Approval log
