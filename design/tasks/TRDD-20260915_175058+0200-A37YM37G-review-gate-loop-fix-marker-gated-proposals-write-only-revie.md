---
trdd-id: A37YM37G
title: Review gate loop fix - marker-gated proposals, write-only review fork, heartbeat and interrupt floors
column: dev
created: 2026-09-15T17:50:58+0200
updated: 2026-09-15T17:50:58+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-15T17:50:58+0200
---

# Review gate loop fix - marker-gated proposals, write-only review fork, heartbeat and interrupt floors

## Why
Owner order 2026-09-15 (verbatim intent): the adversarial review Stop/SubagentStop hook (agentlenspro review-gate) looped and drained the token window. Two loop sources measured in src/cli/reviewGate.ts: (1) the disk mtime walk (unreviewedEffects) armed the MAIN gate on every 5-minute janitor heartbeat for writes made by janitor agents and background workers; (2) role credit EXPIRED when a spawned agent returned without its heading, and a background notification is one JSONL line so a heading can never sit at a line start - every returning measure agent re-blocked the next Stop.
## What changed
- A text block is a proposal ONLY if a line starts with `PROPOSAL FOR ACTION - PLEASE REVIEW` (in the trigger-detection module: PROPOSAL_MARKER/PROPOSAL_LINE); a marked proposal demands a MEASURE agent (ROLE: MEASURE) AND the REVIEW fork (ROLE: REVIEW).
- A write tool (Edit/Write/NotebookEdit outside ephemeral roots) or a write-shaped Bash command (git commit etc.) demands ONLY the REVIEW fork.
- A roled spawn credits its role PERMANENTLY at the spawn index; result headings no longer matter.
- Floors: a `[janitor-heartbeat]` prompt and a `[Request interrupted by user...]` entry forget all earlier work (nothing before them is demanded).
- SubagentStop exempts ai-maestro-janitor:janitor-* / janitor-* agent types, fork, and roled agents.
- The disk-walk effects module and its test are deleted; one shared scan/decision pair serves both gates; the review supervisor honours the same floors.
- User-scope rules updated: propose-then-review-then-implement.md, never-block-the-main-agent.md, fable-plans-sonnet-executes.md now state the marker requirement.
## Acceptance
- [x] tsc + eslint clean on src/cli
- [ ] node esbuild.js exit 0 and the live `agentlenspro review-gate --directive` prints the marker
- [ ] nine smoke cases pass (edit-only blocks with review only; proposal blocks with both; heartbeat/interrupt floors release; janitor subagent released; old `PROPOSAL:` marker inert)
- [ ] unit tests rewritten and green
- [ ] committed with this id in the subject
## Notes
The untracked review-loop module still exists and is out of scope.

## Approval log

- 2026-09-15T17:50:58+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
