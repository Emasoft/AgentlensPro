---
trdd-id: WQKM44AL
title: Check whether real turn-1 input sizes fall inside the history calibration band
column: backburner
status: tasked
created: 2026-09-25T00:17:37+0200
updated: 2026-09-25T00:17:37+0200
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

Next action: scan real turn-1 CLAUDE.md / system-prompt sizes (tens of KB range) against the [0.5, 2] calibration band and record whether any land inside it.

Facts: I9b2 item 4 added only a SHORT instructions+prompt_snapshot pair so that the [0.5, 2] band assertion in calibration_is_asymmetric_between_input_and_output_blocks did not flip. A real CLAUDE.md or system prompt (tens of KB) could land inside the band and calibrate real sessions differently.

Evidence: the I9b2 report, Item 4.

## Approval log

- 2026-09-25T00:17:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
