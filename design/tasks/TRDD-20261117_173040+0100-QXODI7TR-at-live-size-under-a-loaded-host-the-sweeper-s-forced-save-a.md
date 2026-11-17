---
trdd-id: QXODI7TR
title: At live size under a loaded host the sweeper's forced save at stop overran the 8 s stop budget
column: backburner
status: tasked
created: 2026-11-17T17:30:40+0100
updated: 2026-11-17T17:47:23+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:30:40+0100
---

# At live size under a loaded host the sweeper's forced save at stop overran the 8 s stop budget

## Problem
Seen once, 2026-11-17, run LV2 of the TRDD-YR6WX7VQ live-size run (reports_dev/YR6WX7VQ/gate-live/LV2.log lines 34 to 37): a restart on a copy of the live card files (75,106 cards, card log about 143 MB), host 1-minute load rising from 4 to 101 from other work. The file pass ended at 17:28:16; the driver's graceful stop came at about 17:28:42 (INFERRED: the 17:28:50 line minus the 8 s budget; the stop time itself was not read from a log); at 17:28:50 the server printed 'stop gave up waiting on the sweeper thread's own flush — the shared stop budget elapsed' and exited 0. So the sweeper did not finish its forced offsets and card save inside the 8 s budget (AGENTLENS_STOP_LOCK_TIMEOUT_MS default, bin/alcore.rs:288-296) for a reason OTHER than the file pass. What the sweeper was doing in those 8 s is not in the log. After a failed wait nothing else saves the sweeper's state (alcore.rs:655-659, by the worker's report reports_dev/YR6WX7VQ/20261117_172336+0100-stop-path-and-pass-cost.md, not read by the main agent). The card store itself held every card (key sets equal after the run), so no card was lost; the offsets since the last timed save were probably not written (INFERRED from the missed forced save; not checked on the files).

## Not known
Whether the unpatched binary does the same at this size (a control run is in progress on TRDD-YR6WX7VQ); how long a forced save takes at 75,106 cards on a quiet host; whether the sweeper was in a sweep, in save_offsets or in save_cards.
LIMIT from TRDD-YR6WX7VQ (2026-11-17 17:47): a stop is blind while the sweeper is inside a file pass or a save. Seen once (cell DK of the cause run): a graceful stop during a pass gave up after the 8 s budget and exited 0 without the sweeper's forced save; no card was lost and the next start caught up (cell DN). Control at live size: the unpatched binary's restart stopped inside the budget at load 8.8, the patched one overran at load about 101; the loads differ, so whether the overrun predates commit eef01b1d is still open.

## Acceptance
- [ ] The duration of the forced save at live size is measured on a quiet host and under CPU load, with a line in the log that says what the sweeper is doing when a stop waits for it.
- [ ] A decision with evidence: raise the budget, make the save cheaper, or accept the loss of the last offsets save.

## Approval log

- 2026-11-17T17:30:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
