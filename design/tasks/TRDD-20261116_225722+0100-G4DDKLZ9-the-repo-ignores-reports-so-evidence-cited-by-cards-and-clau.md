---
trdd-id: G4DDKLZ9
title: The repo ignores reports/ so evidence cited by cards and CLAUDE.md exists on one machine only
column: backburner
status: tasked
created: 2026-11-16T22:57:22+0100
updated: 2026-11-16T22:57:22+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T22:57:22+0100
---

# The repo ignores reports/ so evidence cited by cards and CLAUDE.md exists on one machine only

## Observation (2026-11-16)
.gitignore line 40 is /reports/ (git check-ignore -v reports/z0a777xw/20261008-box3-samples.tsv names that line). The user rule reports-and-memory says reports/ is git-tracked and only reports_dev/ is ignored. CLAUDE.md doctrine sentences cite evidence under reports/, and TRDD-Z0A777XW was accepted on a TSV under reports/ that git cannot restore.

## Not decided
Whether to track reports/ (every file must pass sanitize-reports first; the folder size and content were not measured) or to keep it ignored and say so in CLAUDE.md. This is the owner's choice, because tracking publishes the files on the next push.

## Acceptance
- [ ] the owner's choice is recorded here
- [ ] .gitignore and CLAUDE.md agree with that choice

## Approval log

- 2026-11-16T22:57:22+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
