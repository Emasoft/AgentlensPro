---
trdd-id: Z0YKJ67N
title: The every-cause label test lists the causes by hand
column: complete
status: archived
created: 2026-09-25T00:57:12+0200
updated: 2026-10-04T12:51:15+0200
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
- 2026-10-04T12:51:15+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". Independent verification docs_dev/20261004_123719+0200-close-verify-cv2.md, HEAD 8b9e9637: tests/cachebreak_parity.rs:153 asserts all.len() == labels.len(), cachebreak_parity ok. 17 passed; decision under the directive: option 2 of the card, the length assertion against the TS table, is present and passes; the array is still hand-kept..

## Acceptance

- [x] 1. the every-cause label test derives its list from the Cause enum OR asserts its length against the TS CAUSE_LABEL key count (verified: tests/cachebreak_parity.rs:153 assert_eq!(all.len(), labels.len()), present since e2c8e5fa; cachebreak_parity ok. 17 passed; option 2 met, array still hand-kept; cv2 2026-10-04)
