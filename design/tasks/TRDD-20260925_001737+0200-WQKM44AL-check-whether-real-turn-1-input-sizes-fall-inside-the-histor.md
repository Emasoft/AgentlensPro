---
trdd-id: WQKM44AL
title: Check whether real sessions' turn-1 estimate ratio falls inside the history calibration band
column: todo
status: tasked
created: 2026-09-25T00:17:37+0200
updated: 2026-09-25T01:54:57+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:17:37+0200
---

# Check whether real turn-1 input sizes fall inside the history calibration band

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Next action: The [0.5, 2] band is a RATIO (sum of block estimates / reported input tokens), not a size. For N real sessions, compute the turn-1 ratio of block-estimate sum to (input + cache_creation + cache_read) before and after 079f7839 (I9), and count the sessions whose tokenSource flips between estimated and calibrated.

Facts: I9b2 item 4 added only a SHORT instructions+prompt_snapshot pair so that the [0.5, 2] band assertion in calibration_is_asymmetric_between_input_and_output_blocks did not flip. A real CLAUDE.md or system prompt (tens of KB) could land inside the band and calibrate real sessions differently.

Evidence: the I9b2 report, Item 4.
The concern is shipped behaviour from I9 (079f7839), not only the I9b2 fixture choice.

## Approval log

- 2026-09-25T00:17:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-25T00:22:52+0200 — column → todo by main-agent@agentlenspro.
