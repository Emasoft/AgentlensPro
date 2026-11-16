---
trdd-id: U38HC114
title: review mod reports a subagent as blocked when its review verdict is PASS with findings
column: todo
status: tasked
created: 2026-11-16T22:07:40+0100
updated: 2026-11-16T22:07:40+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T22:07:40+0100
---

# review mod reports a subagent as blocked when its review verdict is PASS with findings

## Observation (2026-11-16)
The harness header for a reviewed subagent reads "the subagent was blocked once with these findings" and the status line reads "review: <agent> blocked once (round N/2)" while the report under it says VERDICT: PASS. The owner asked why subagent reviews are blocked.

## Cause (code read in agentlenspro-review-mod/hooks/register.js, version 0.7.10)
By design (comment at lines 54-58): a subagent whose review carries ANY finding line is stopped so it can answer the findings: once per review round, and a turn gets at most two rounds, so one subagent turn can be stopped twice (code read in full, lines 1150-1230; measured 2026-11-16: one worker was stopped in both rounds, then its third stop went unreviewed). Line 1206: `const findings = res.block || hasFindings(res.text)`; hasFindings (lines 1034-1036) matches BLOCKER, SHOULD-FIX and NIT alike. Only a PASS with no finding lines lets the subagent stop. Each agent turn gets at most MAX_ROUNDS = 2 reviews (line 72); a third stop is not reviewed and the parent is told to check the handback itself.

## Issue
1. The word "blocked" reads as a failed review although the verdict is PASS.
2. A review with only NIT findings still costs the subagent one more turn and one more review.

## Fix (the owner delegated the decision 2026-11-16, verbatim: "review in my stead. decide yourself.")
- Hold the subagent only for BLOCKER or SHOULD-FIX findings; a NIT-only review goes to the parent without holding the subagent.
- Word the header and the status by verdict: "held once to answer N finding(s) (verdict PASS)" versus "blocked (verdict BLOCK)".

## Acceptance
- [ ] a NIT-only PASS review does not stop the subagent and still reaches the parent
- [ ] a PASS review with a SHOULD-FIX holds the subagent once and the header says "held", not "blocked"
- [ ] a BLOCK review still blocks and says "blocked"

## Approval log

- 2026-11-16T22:07:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
