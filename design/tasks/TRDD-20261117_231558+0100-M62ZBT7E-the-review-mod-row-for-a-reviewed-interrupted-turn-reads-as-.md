---
trdd-id: M62ZBT7E
title: The review mod row for a reviewed interrupted turn reads as a failed review
column: human_review
status: tasked
created: 2026-11-17T23:15:58+0100
updated: 2026-11-19T01:34:14+0100
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
implementation-commits: [44f31935, 1266d508]
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
- [x] The row says in plain words that the review of an interrupted turn FINISHED, with its verdict (PASS or BLOCK) before the cost.
- [x] A review of an interrupted turn that could NOT run keeps its own distinct wording (REVIEW DEFERRED), so the two cannot be confused.
- [x] The mod version is bumped and its change note says what the row means.

## Approval log

- 2026-11-17T23:15:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T00:07:03+0100 — column → dev by main-agent@agentlenspro. the mods-expert-developer agent is working on it (owner directive 2026-11-18)
- 2026-11-19T01:08:28+0100 — column → human_review by main-agent@agentlenspro. built and tested in review mod 0.7.13 (1266d508); the live display check needs the owner

## Notes

2026-11-17T23:34:06+0100 CORRECTION after two harness reviews (main agent; local read of two transcripts, listings in reports_dev/M62ZBT7E/20261117_2333-llmext-window.txt and 20261117_2335-janitor-after-2307.txt, both read whole). (1) 'A review that ran to its end' holds for ONE row only: the 22:56 row has its report in the next Stop display (heading 'interrupted turn 22:56', VERDICT PASS). For the 23:07:27 row no such heading is in the transcript up to its last entry (23:31:58 local), across four later Stop displays and a compaction at 23:11:10; no REVIEW DEFERRED or REVIEW FAILED row either. That review made its model calls and its report was not shown: TRDD-ISEF8YO7. By the 0.7.11 source the row is printed from a finally block for any model call, also when no report came out; the installed copy (newest in the plugin cache: 0.7.10) was not compared. So the row means 'the review made its calls', and box 1 of the Acceptance list must not promise a verdict the code does not have at that point without reading it there. (2) CAUSE: 2 of 3 rows follow a prompt taken from the input queue while a turn ran (both in one session). The third (another session, 22:26:25 local): the Stop hook ended at 22:24:53, a continuation request began at 22:24:56.806 after Stop-hook feedback, the queued prompt was dequeued at 22:24:56.937 and a new request began at .993; no entry marks an abort, so it fits only if the dequeue cut the continuation that had begun 131 ms before. An Esc press is not excluded for any row; the entries listed in the two files hold no '[Request interrupted' text. The rows of 15 and 16 November were not tested. (3) COST: the two costs read since the boot are 0.1826 and 0.1587 USD; 0.2338 and 0.1536 belong to rows of 15 and 16 November; the cost of the third row was not read. 'Every prompt typed while a turn runs buys one extra review' is conditional on the inferred cause.
2026-11-17T23:43:23+0100 SECOND CORRECTION (main agent). The 23:07:27 review DID finish: its report (tag 'run by the harness, interrupted turn', VERDICT PASS) is in the prompt context of 23:14:44 local. Only the box for the user was lost, at a compaction (TRDD-ISEF8YO7 holds the cause). So in that session both rows belong to reviews that finished and whose reports reached the model; the third row (another session) was not checked for its report. The code facts stand: the row is printed for any model call, also when no report came out, so three outcomes exist at that point (PASS, BLOCK, calls made and no report) and the row must name the one that happened. The installed copy is 0.7.10 and equals the 0.7.11 source in logUsage, reviewInterrupted, defer and reviewAtStop (diff hunks only at lines 54 to 88 and 1033 to 1238).
OWNER DIRECTIVE 2026-11-18 00:00 (verbatim): «mods are too complex. only the mods-expert-developer agent can be consulted on them, and developing must be delegated to it.» From here the mod work of this card is designed, written and tested by the agent mods-expert-developer-plugin:mods-expert-developer-agent. The main agent writes no mod code and takes mod questions to that agent.
2026-11-19T01:25:02+0100 main agent: removed from TRDD-HSPUF5XH blocked-by as RISK ACCEPTED (not in the npm package). The line with its failure mode and whether the mechanism existed at v2.33.1 is in HSPUF5XH, section 'Release list decision 2026-11-19'. This card stays open; only the release gate changed.
2026-11-19T01:34:12+0100 main agent: the move of this card to human_review in 3fbdda8c was DIRECT from dev, skipping testing and ai_review; the harness review of that turn was the only AI review. Its type-check evidence (tsc) used the owner's untracked agentlenspro-review-mod/tsconfig.json, which 1266d508 does not carry.

## Result 2026-11-19

2026-11-19T01:08+0100 main agent: the code shipped in 0.7.12 (44f31935); 0.7.13 (1266d508) adds tests for the finished row (PASS and BLOCK, verdict before cost) and the REVIEW DEFERRED wording, and a README note. Evidence (run by the main agent on 1266d508's tree): claude plugin test 23 pass 0 fail; python3 -I tests/test_show.py 10 OK; tsc -p rc 0. Mutations M1-M15 red by the mods agent report (reports/mods-expert-developer-agent/20261119_four-cards.md, read whole; that file is gitignored). NOT run: a live session (Esc + compaction + Stop with a held box over the limit; a reload then /clear; a round-cap deferral then a prompt); the installed mod is still 0.7.10.
