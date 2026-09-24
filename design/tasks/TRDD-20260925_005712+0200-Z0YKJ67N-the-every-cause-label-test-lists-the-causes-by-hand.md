---
trdd-id: Z0YKJ67N
title: The every-cause label test lists the causes by hand
column: backburner
status: tasked
created: 2026-09-25T00:57:12+0200
updated: 2026-09-25T00:57:12+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:57:12+0200
---

# The every-cause label test lists the causes by hand

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Next action: derive the `all` array in cachebreak_parity.rs's every_cause_carries_the_ts_label_and_remediation
from the Cause enum itself, or add an assertion that its length matches the TS CAUSE_LABEL table's key count.

Fact: cachebreak_parity.rs's every_cause_carries_the_ts_label_and_remediation iterates a
hand-kept `all` array, so a new Cause left out of it goes unchecked; I6c2 had to add
IDLE_TTL_PARTIAL_EXPIRY to that array by hand. Cites
reports/cc-alignment/20260925_005341+0200-head-156a6768-clean-checks.md.

## Approval log

- 2026-09-25T00:57:12+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
