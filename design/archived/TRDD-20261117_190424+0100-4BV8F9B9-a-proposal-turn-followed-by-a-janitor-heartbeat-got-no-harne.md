---
trdd-id: 4BV8F9B9
title: A proposal turn followed by a janitor heartbeat got no harness review
column: complete
status: archived
created: 2026-11-17T19:04:24+0100
updated: 2026-11-17T20:30:47+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T19:04:24+0100
---

# A proposal turn followed by a janitor heartbeat got no harness review

## Problem
Seen twice on 2026-11-17 in the AgentlensPro session. A turn whose reply carried the exact line `PROPOSAL FOR ACTION - PLEASE REVIEW` (the clear-flag proposal of TRDD-PGMMB2QG, sent at about 18:39 and again at about 18:57) ended, and no harness review or measurement of that turn reached the main agent. The second time, the next prompt was a `[janitor-heartbeat]` fire, which is exempt from review; the prompt after it carried only the reviews of a subagent. Whether the first time had the same shape is not checked. INFERRED, not read in the mod code: the review of a turn is delivered with the next prompt, and an exempt next prompt drops it.
FOUND (2026-11-17T20:29:50+0100, main agent). The guess above is REFUTED: a janitor prompt does not drop a review. MEASURED in this session's own transcript file (read locally, line numbers of that file; times are local): (1) the proposal sent at 18:37:09 got its measurement and its review; its Stop ended at 18:38:36 and both reports were injected by the prompt.submit hook into the [janitor-heartbeat] prompt of 18:38:36 (entry 32871, 8,624 characters, one MEASURE head and one REVIEW head). So a cron heartbeat prompt does fire prompt.submit and does carry the review. READ BY ME in agentlenspro-review-mod/hooks/register.js (source 0.7.11): :1282-1295, the handler takes the stored report at the first prompt.submit of any kind and marks it injected; the comment at :1274-1281 says a janitor prompt receives it too, by design. (2) THE 18:39 PROPOSAL (entry 32901, 18:39:37) was written by the agent INSIDE that heartbeat turn (first line 'janitor heartbeat', the marker alone on its line 6). A janitor turn is never reviewed or measured (:1325, isJanitorPrompt(turnPrompt), owner rule), so that proposal got nothing. CAUSE 1 is the agent's own act: a proposal placed in a janitor turn. (3) THE 18:57 PROPOSAL (entry 33458, 18:57:09): its Stop took 2.6 s and printed to the user only 'REVIEW DEFERRED to the next stop (not dropped): cap of 2 blocking rounds reached this turn' (entry 33460). READ BY ME: :899-901 (the cap, MAX_ROUNDS) and :828-835 (defer: a user note, a status line, a counter, a debt in the session record; nothing for the model). The turn had been continued by Stop-hook feedback three times (17:49, 17:54 a review BLOCK, 17:56 local +1 h) without a turn end, so the cap counted across them. The heartbeat turn after it is exempt; the next non-janitor Stop was reviewed and that review reached the model with the heartbeat prompt of 19:05:44 (entry 33602): it holds ONE review head and NO measurement head, and its findings are about the later turn. CAUSE 2: the round cap deferred the review, the model was not told, and the deferred proposal was never measured. NOT read by me: the lines of the worker report other than those named here (reports_dev/4BV8F9B9/20261117_202245+0100-review-delivery-path-v2.md; the worker's fix proposal, to hold a report back at a janitor prompt, is NOT adopted: delivery at a janitor prompt works and is by design). The installed mod is 0.7.10 by the worker report (cmp says its register.js differs from the 0.7.11 source in 11 hunks, none in the main-turn path by its reading; not checked by me).
CORRECTION (2026-11-17T20:30:09+0100): the three times in parentheses in the FOUND line (17:49, 17:54, 17:56) are UTC as the transcript prints them; local they are 18:49, 18:54 and 18:56.
BOX 2 (2026-11-17T20:30:21+0100): ticked on its first half. A reviewed turn followed by a janitor prompt does get its review delivered, at that janitor prompt: measured at transcript entry 32871 (18:38:36) and seen again today at about 20:20, when the review of a main turn arrived with a [janitor-heartbeat] prompt and the agent read it there. No code change. The limit that a proposal written inside a janitor turn is never reviewed is already in the rule the proposer reads (turn-protocol-and-review, 'every janitor-originated turn ... is never reviewed or measured, whatever it did'). The silent deferral and the lost measurement are TRDD-ASXUW08U.

## Acceptance
- [x] The delivery path of a turn review is read in agentlenspro-review-mod and the cause is stated with file and line.
- [x] A reviewed turn followed by a janitor prompt still gets its review delivered (or the limit is documented where the proposer reads it).

## Approval log

- 2026-11-17T19:04:24+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T20:18:08+0100 — column → dev by main-agent@agentlenspro. read-only diagnosis handed to a worker (box 1)
- 2026-11-17T20:30:47+0100 — COMPLETE by main-agent@agentlenspro. both boxes ticked on measured transcript evidence and code read; no code change; the defect found on the way is TRDD-ASXUW08U.
