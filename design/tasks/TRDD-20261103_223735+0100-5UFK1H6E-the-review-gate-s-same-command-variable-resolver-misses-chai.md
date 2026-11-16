---
trdd-id: 5UFK1H6E
title: The review gate's same-command variable resolver misses chained assignments and command substitution
column: todo
status: tasked
created: 2026-11-03T22:37:35+0100
updated: 2026-11-03T22:37:35+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T22:37:35+0100
---

# The review gate's same-command variable resolver misses chained assignments and command substitution

## Symptom
Scratch writes to ephemeral paths arm the review gate, and each false arm costs one review fork, when the target variable is assigned in the same command in a form the resolver does not follow.

## Evidence
✓ VERIFIED 2026-11-03 by replaying session ff701ebd's Bash calls through the compiled commandWriteReasons (out/test/cli/reviewGateTriggers.js, cwd = repo root):
- 19:30:13Z, the original TRDD-PV5BIND2 incident: `S=/private/tmp/.../scratchpad/gateprobe; ...; T=$S/t.jsonl; printf ... > $T` returns ["redirect into $T"]. T is assigned in the same command, but from another variable.
- 20:44:16Z: `f=<repo>/reports_dev/7ypqwkpg/$(date +%Y%m%d_%H%M%S%z)-orchestrator-state.md; ... | fastedit create "$f"` returns ["fastedit create"]. The directory is literal and under reports_dev; only the file name comes from a command substitution.
- Already handled: a literal same-command assignment (`f=/tmp/y.md; echo a > "$f"` returns []), and literal /tmp, /private/tmp and reports_dev targets (return []).
- ? INFERRED: the supervisor uses the same target test, because it imports its classifiers from reviewGate.ts (reviewSupervisor.ts:23). Not traced.

## Proposed fix
In the same-command assignment resolver behind commandWriteReasons (src/cli/reviewGateTriggers.ts): (1) expand `$VAR` and `${VAR}` references inside an assignment value from earlier assignments in the same command; (2) when only the final path component is dynamic (a `$(...)` or an unresolved `$VAR` after the last `/`), judge ephemerality on the literal directory. Everything else stays undecidable and counts as a write, as the gate directive requires.

## Why it matters
Each false arm costs one review fork; in this session each used about 300k tokens of context.

## Context
Split from TRDD-PV5BIND2 (cancelled). That card's statement that both cases used variables set outside the command was wrong.

## Approval log

- 2026-11-03T22:37:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
