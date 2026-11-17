---
trdd-id: M62ZBT7E
title: The review mod row for a reviewed interrupted turn reads as a failed review
column: backburner
status: tasked
created: 2026-11-17T23:15:58+0100
updated: 2026-11-17T23:25:31+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T23:15:58+0100
---

# The review mod row for a reviewed interrupted turn reads as a failed review

## Problem
For the review of a turn that was cut short the review mod prints one user-only row (agentlenspro-review-mod/hooks/register.js, logUsage, the branch with no sink): review-mod: interrupted review <cost> · in N · out N · cache r N / w N · box after next reply. On 2026-11-17 the owner read it as an error (verbatim): "i got multiple errors in many claude instances with the agent review failing due to being interrupted". The row is the COST of a review that ran to its end; the word interrupted names the reviewed turn, not the review. The row carries no verdict and no word that says the review finished.

## Evidence (2026-11-17, one other session on this machine, transcript read by the main agent)
- Two rows after the reboot, at 22:56:02 and 23:07:27 local. Each follows by 37 to 50 s a prompt that was submitted while a turn was still running, with no Stop between the start of that turn and the prompt: a janitor arm slash command at 22:55:25, and a message typed by the owner at 23:06:45.
- The report of the first one is in the next Stop display, headed "interrupted turn 22:56" with VERDICT PASS. So the review ran and was delivered.
- INFERRED from that timing, not from documentation: a prompt submitted mid-turn ends the running turn with isAborted true. The mods documentation says only that turn.complete has isAborted true for a turn the user interrupted.
- Code path: turn.complete with isAborted on a main, non-janitor turn starts reviewInterrupted from a timer after 1.5 s; its finally block calls logUsage with no sink, which prints the row.
- 2026-11-17T23:25:30+0100 WIDER PASS (main agent, local read of the 4 transcripts written since the boot at 21:45, from the boot to 23:25): 3 rows 'interrupted review' in 2 sessions (2 and 1), 0 in the other two; 0 rows REVIEW FAILED and 0 rows REVIEW DEFERRED. All 3 rows follow a prompt taken from the input queue: two have the queue entries next to them (enqueue then dequeue of a typed message; in one of them the dequeue lands 8 s after the enqueue with no Stop since the turn began), one follows a slash command. The reviews took 37, 42 and 89 s. So the row is not frequent and the wording-only scope of this card stands. What stays INFERRED: that a queued prompt delivered while a turn runs ends that turn as aborted (3 of 3 rows fit; no documentation says it). COST not in scope here: each such review reads the whole conversation again (273k to 418k tokens from cache in the rows seen, 0.15 to 0.23 USD each), so every prompt typed while a turn runs buys one extra review.

## Acceptance
- [ ] The row says in plain words that the review of an interrupted turn FINISHED, with its verdict (PASS or BLOCK) before the cost.
- [ ] A review of an interrupted turn that could NOT run keeps its own distinct wording (REVIEW DEFERRED), so the two cannot be confused.
- [ ] The mod version is bumped and its change note says what the row means.

## Approval log

- 2026-11-17T23:15:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
