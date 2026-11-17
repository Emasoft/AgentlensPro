---
trdd-id: ML7V29LR
title: Owner question - run the turn review asynchronously instead of blocking the stop
column: backburner
status: tasked
created: 2026-11-17T23:15:58+0100
updated: 2026-11-17T23:43:25+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T23:15:58+0100
---

# Owner question - run the turn review asynchronously instead of blocking the stop

## Owner question (2026-11-17, verbatim)
"why the review is not executed for every turn async?"

## How it works today (agentlenspro-review-mod/hooks/register.js, source 0.7.11, read by the main agent)
- The review of a finished main turn runs INSIDE the Stop hook, before next(e), and the stop waits for it. Two reasons are written at the handler: it is a gate (a BLOCK verdict blocks the stop so the same turn goes on and fixes the findings), and the plugin Stop command hook prints the coloured user-only report, so the display file must be complete before the other Stop hooks run. Cost written there: every other Stop hook waits for the review.
- The only review that already runs outside the turn is the one of an interrupted turn (no Stop fires): a timer, the report stored and injected with the next prompt, the box shown at the next Stop.
- Turns that get no review: janitor turns (owner order); a turn opened by a message of another agent that wrote nothing and proposed nothing; a Stop fired again with nothing new; a turn past the cap of 2 blocking rounds (deferred, TRDD-ASXUW08U); a review fork that failed after its retries (deferred, debt left for the next stop).
- Owner order the present design rests on (2026-11-14, verbatim): "it must be part of the harness cycle, unskippable".

## Options
1. Keep the synchronous gate (today).
2. Asynchronous for every turn: the Stop returns at once, the review runs from a timer, every report (BLOCK too) is injected with the next prompt. Loses: a BLOCK can no longer hold the turn, the agent may have gone on before it reads the findings, and in an unattended session the next prompt may be a heartbeat. Gains: no wait at each stop, and no review deferred by the round cap.
3. Mixed: asynchronous by default, synchronous only for a turn that carries the proposal marker or wrote outside the scratch folders.

## Acceptance
- [ ] The choice of the owner is recorded here with its date.
- [ ] If the choice changes the design, a card for the implementation is filed and linked.

## Release gate
Not added to the blockers of TRDD-HSPUF5XH: this is a design question for the owner, not a defect; nothing can be completed here without the answer of the owner.

## Approval log

- 2026-11-17T23:15:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-17T23:43:23+0100 AFTER TWO HARNESS REVIEWS (main agent). (1) The recommendation 'mixed' is WITHDRAWN: its criterion (block only when the turn carries the proposal marker or wrote files) keeps almost every working turn of a session like this one blocking, because the scanner counts a git commit as work; no share of turns was counted and no wait per Stop was timed, so no gain is known. The three options stand without a recommendation. (2) MISSING CASE for any async option: a review still running when the next prompt arrives (where does its report go, and does a BLOCK that arrives late still block). (3) Waits seen, not a measurement: three reviews of interrupted turns took 37, 42 and 89 s; in another session one Stop phase took 132 s from the end of the turn to the end of its Stop hooks (all Stop hooks together). (4) Turns that get no review today, by the 0.7.11 source: a janitor turn; a turn opened by a message of another agent that wrote and proposed nothing; a Stop fired again with nothing new; an interrupted turn with no work and no proposal; a review that failed is retried by blocking the stop and deferred after 2 rounds (MAX_ROUNDS = 2, line 72); a turn past the cap of 2 blocking rounds is deferred.
