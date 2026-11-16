---
trdd-id: U38HC114
title: review mod reports a subagent as blocked when its review verdict is PASS with findings
column: publish
status: tasked
created: 2026-11-16T22:07:40+0100
updated: 2026-11-16T22:55:20+0100
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
implementation-commits: [43e4c862]
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
- 2026-11-16T22:55:20+0100 — column → publish by main-agent@agentlenspro. code committed in 43e4c862; going live needs a push, which is the owner's act

## STATE

2026-11-16 22:53 — DECIDED SCOPE: a NIT-only review no longer holds the subagent at EITHER gate: its SubagentStop is not held and its SubagentHandback is not refused (before, a NIT-only review refused the handback once). This handback case is a behaviour change the three acceptance boxes did not name; it is intended. Edits are in the tree (register.js, README.md, plugin.json 0.7.11), not yet verified by the main agent, not committed. The runtime path is NOT tested: the mod has no test suite; the only check so far covers the two regexes.
2026-11-16 22:53 — OBSERVED, not acted on: agentlenspro-review-mod/tsconfig.json is untracked (56 bytes, dated 2026-11-14 23:00, content: extends ./.claude-plugin/types/tsconfig.json). Its origin is not known. It is neither committed nor removed.
2026-11-16 22:55 — CODE COMMITTED in 43e4c862 (0.7.11). NOT LIVE: this machine runs the installed 0.7.10 from the GitHub marketplace emasoft-plugins (cache path .../agentlenspro-review-mod/0.7.10), so the fix runs only after a push, a marketplace update and a plugin reload; pushing is the owner's act. The three acceptance boxes stay unticked until a live review shows each case. NEXT ACTION: after the owner pushes, update the plugin and watch one NIT-only review, one SHOULD-FIX review and one BLOCK review.
