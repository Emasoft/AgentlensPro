---
trdd-id: 5Q5E8I7W
title: A damaged card log is never healed
column: todo
status: tasked
created: 2026-11-17T13:18:58+0100
updated: 2026-11-17T13:18:58+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:18:58+0100
---

# A damaged card log is never healed

## Problem
When the card-log files cannot be read at a reused start (a corrupt line in the middle, an I/O error), change 2 of TRDD-WCG7I5D8 prints one stderr line, seeds from the card store and leaves the files as they are, at every start. The unpatched code never reads the files at a reused start, so it does not notice either. The card log is the fallback for a store that cannot be reused, so a damaged one means no fallback. Evidence: the diff of log_reader.rs in reports_dev/WCG7I5D8/change1plus2-combined.patch and the test a_reused_start_with_a_card_log_corrupt_mid_file_seeds_from_the_store_and_stays_clean in card_reuse.rs (worktree builds_dev/wt-jdq-commit).

## Fix direction
When the store was reused healthy and the card log is unreadable, rewrite the card log from the store (a compaction from the resident cards), after keeping the damaged files aside.

## Acceptance
- [ ] A reused start next to a card log with a corrupt middle line ends with a card log that load() reads and that holds the store's cards; the damaged files are kept under another name.

## Approval log

- 2026-11-17T13:18:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
