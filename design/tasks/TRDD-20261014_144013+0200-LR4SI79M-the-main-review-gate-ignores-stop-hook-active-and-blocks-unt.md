---
trdd-id: LR4SI79M
title: The forced review gate can be overridden by Claude Code's 9-consecutive-Stop-block cap
column: todo
status: tasked
created: 2026-10-14T14:40:13+0200
updated: 2026-10-14T14:43:23+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T14:40:13+0200
project-id: agentlenspro
---

# The main review gate ignores stop_hook_active and blocks until the 9-consecutive-block cap pauses the goal

## Approval log

- 2026-10-14T14:40:13+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-14 — authority is the owner's direct request (Q4), not a self-issued mandate.

## Facts

runMainGate deliberately ignores stop_hook_active (src/cli/reviewGate.ts:194-199, 794-817, no-give-up policy); runSubagentGate honours it (:841-844).
On 2026-10-14 Claude Code overrode a turn after 9 consecutive Stop blocks and paused the active goal.
Split out of TRDD-QQ2XIIZ6.
Framing (owner ruling 2026-10-14, supersedes the earlier Facts framing): runMainGate ignoring stop_hook_active is INTENDED (no-give-up, re-confirmed by the owner) and must stay. The open question is the harness cap CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (default 9), which overrides the block: raise the cap, or make the gate block unmissable.

## Owner directive (verbatim, 2026-10-14)

Q4: "if the hook decides that the turn is worthy of being reviewed, the hook must block the agent until he spawn a fork agent. it must be forced to do it or it won't go to the next turn."

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-14

Title above is superseded by the frontmatter title: the gate refusing to release is intended (owner Q4).
Evidence correction: the 2026-10-14 nine-block override was driven by the goal checker's repeated Stop feedback; whether review-gate blocks count toward CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is unverified.
Interaction with TRDD-QQ2XIIZ6: once the gate scans only the last turn, a cap override or an interrupted turn loses that turn's review permanently (no carry-over), so this card becomes more urgent when QQ2XIIZ6 deploys.
Open owner decision: whether to remove the REVIEW-GATE NO REVIEW POSSIBLE text escape.
