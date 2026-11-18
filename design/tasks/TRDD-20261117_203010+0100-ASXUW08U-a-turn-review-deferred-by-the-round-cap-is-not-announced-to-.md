---
trdd-id: ASXUW08U
title: A turn review deferred by the round cap is not announced to the model and its proposal is never measured
column: backburner
status: tasked
created: 2026-11-17T20:30:10+0100
updated: 2026-11-18T00:00:51+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T20:30:10+0100
---

# A turn review deferred by the round cap is not announced to the model and its proposal is never measured

## Problem
Found while closing TRDD-4BV8F9B9 (its FOUND line holds the evidence and the transcript entry numbers). On 2026-11-17 at 18:57 a turn of the AgentlensPro session ended with a reply that carried the line PROPOSAL FOR ACTION - PLEASE REVIEW. Its Stop reached the cap of 2 blocking rounds (agentlenspro-review-mod/hooks/register.js:899-901, source 0.7.11; the turn had been continued three times by Stop-hook feedback, one of them a review BLOCK). The mod deferred the review (register.js:828-835): a yellow note for the user, a status line, a counter, a debt in the session record. The model got nothing, so the proposer waited for a review and a measurement that did not come. The debt was paid by the review of the next non-janitor turn; the report that reached the model at 19:05 holds one review and NO measurement, and its findings are about that later turn.

Two defects, both read in code and seen once in a transcript, neither reproduced in a probe:
1. The model is not told that the review of its turn was deferred.
2. A proposal whose Stop is deferred is never measured: the measurement runs only when the Stop that reviews finds the marker in its own turn.

Not established: whether the Stop-hook feedback of another plugin (the goal hook) should count toward the round cap at all; the counter is raised only by a review BLOCK or a failed review (by a worker reading of register.js, not read by me), so how two rounds were reached in that turn is not traced.
CAUTION (2026-11-17T20:47:00+0100, main agent, after the harness review of the turn that closed TRDD-4BV8F9B9; that card is archived and cannot be corrected). Three statements in its FOUND line, and repeated above, are INFERRED and not measured: (1) 'the turn had been continued by Stop-hook feedback three times, so the cap counted across them': only one of the three was a review BLOCK, and how the counter reached 2 is not traced (box 1 here); (2) 'the next non-janitor Stop paid the debt': I read the report injected at 19:05 (one review, no measurement) but not the Stop display of that Stop, nor that it ran with the debt set; (3) 'the deferred proposal was never measured' rests on that one injected entry. If (2) or (3) is wrong, defect 2 above is partly not there. Also: the silent deferral is documented nowhere a proposer reads (not in the rule file, not in the mod README); only a project memory atom (ATOM-E7SR-7AR3) says it.

## Acceptance
- [ ] How the cap was reached in the 18:57 turn is traced (which stops raised the counter), with file and line.
- [ ] When a review is deferred, the model receives one line at the next prompt that says so and names the reason.
- [ ] A deferred proposal is measured when its debt is paid, or the limit is stated in that line.
- [ ] A probe or test shows both, and the mod version is bumped.

## Approval log

- 2026-11-17T20:30:10+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

OWNER DIRECTIVE 2026-11-18 00:00 (verbatim): «mods are too complex. only the mods-expert-developer agent can be consulted on them, and developing must be delegated to it.» From here the mod work of this card is designed, written and tested by the agent mods-expert-developer-plugin:mods-expert-developer-agent. The main agent writes no mod code and takes mod questions to that agent.
