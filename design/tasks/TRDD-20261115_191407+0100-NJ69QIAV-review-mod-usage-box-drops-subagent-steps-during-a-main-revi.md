---
trdd-id: NJ69QIAV
title: Review-mod usage box drops subagent steps during a main review and shows no box at the review cap
column: todo
status: tasked
created: 2026-11-15T19:14:07+0100
updated: 2026-11-15T19:14:25+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-15T19:14:07+0100
parent-trdd: KZCSO0R2
---

# Review-mod usage box drops subagent steps during a main review and shows no box at the review cap

## Approval log

- 2026-11-15T19:14:07+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Defects

- (a) In agentlenspro-review-mod/hooks/register.js, reviewDepth is a single global counter; recordStep skips every turn.step while reviewDepth > 0, so a subagent's steps made while a MAIN review is running are missing from that subagent's "turn under review" section (observed 2026-11-15 in a `claude -p` probe: continuation steps idx3-4 missing from the 2nd review, which still showed 3 calls). Evidence: reports_dev/review-mod/20261115_*-release-077.md.
- (b) A subagent turn that reaches the 2-round review cap prints "NOT REVIEWED ... cap of 2 review rounds reached" and no usage box, so its turn-under-review usage is never shown.
- (c) The main-turn cache warm/cold row has never been seen live: `agentlenspro cache-state` exits 2 under `claude -p` (no status-line sample); needs one interactive (tmux) session check.

## Acceptance

(a) steps are tracked per agent so a main review never drops a subagent's steps; (b) a capped subagent still gets its usage box; (c) one interactive Stop box shows `cache warm` or `cache cold` with a ttl.
