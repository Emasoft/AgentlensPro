---
trdd-id: PNB9FNJ0
title: A delegate-gate-denied Edit still arms the review gate so every denied edit costs a fork
column: todo
created: 2026-09-10T18:55:00+0200
updated: 2026-10-04T13:42:08+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: high
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [review-gate, delegate-gate, fork-cost]
related: [X8MW8K92, 2CYTNLY1]
---

# A delegate-gate-denied Edit still arms the review gate so every denied edit costs a fork

## Defect

A PreToolUse deny leaves the `Edit` tool_use in the transcript; `scanMainTranscriptLines`
(`src/cli/reviewGate.ts`) arms on EDITORS tool_uses regardless of the paired tool_result, so once
`agentlenspro delegate-gate` (TRDD-X8MW8K92) is live, every Fable habit-slip or gate misfire
demands a review fork for an edit that never happened.

## Fix

The scan skips an EDITORS tool_use whose paired tool_result (same tool_use_id) carries the
delegate-gate deny marker (the first words of `DELEGATE_DENY_REASON`, or the harness's
hook-deny text — read one real denied entry first to pin the exact shape); `scanSupervision` in
reviewSupervisor.ts gets the same skip.

## Acceptance

- [x] Real-transcript-fixture test (denied Edit → not armed; allowed Edit → armed; mutation
      proven)
- [x] Gate suites green
- [ ] Live: one denied Fable Edit followed by Stop demands no fork

## Approval log
2026-10-04T13:05:00+0200 -- worker wA: deniedToolUseIds() in src/cli/reviewGate.ts (is_error tool_result carrying DELEGATE_DENY_REASON's lead sentence) skipped in scanTranscriptLines and scanSupervision; tests 'a delegate-gate-denied edit does not arm' (reviewGate.test.ts, 3 cases) and 'a delegate-gate-denied edit is not work' (reviewSupervisor.test.ts). Fixture uses the deny text the code emits; the harness wrapper around it is unmeasured (substring match, is_error required). Mutation: skip disabled gave 2 failing, restored gave 105 passing. check-types/lint/compile-tests exit 0. Live box is the owner's.

## Notes

2026-10-04 follow-up from review: the skip is restricted to editor tools (isDeniedEdit in reviewGate.ts, used by the gate and the supervisor); a write-shaped Bash whose error result quotes the deny sentence still arms/counts. Tests: reviewGate 'a write-shaped Bash whose error result quotes the deny sentence still arms', reviewSupervisor '...still counts'; red against the unrestricted skip (2 failing), green after (18 passing).
