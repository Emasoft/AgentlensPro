---
trdd-id: AVUGZV1K
title: Owner directive 2026-10-04 complete all TRDDs - per-card triage then work in waves
column: dev
status: tasked
created: 2026-10-04T12:48:47+0200
updated: 2026-10-04T12:48:47+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: audit
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-04T12:48:47+0200
---

# Owner directive 2026-10-04 complete all TRDDs - per-card triage then work in waves

Owner directive, quoted verbatim: "complete all TRDDs!" (2026-10-04, mid-session).

Method: seven read-only triage workers classify every open card (A-CLOSE done and verified, B-SMALL, C-LARGE, D-OWNER, E-OBSOLETE, F-UNCLEAR). Reports go in gitignored docs_dev; 20261004-board-triage-spec.md is the spec. No card is moved to complete on a worker word: the main agent verifies each A-CLOSE itself or through a second independent worker, never on INFERRED evidence.

Work order: owed fixes first, then verified closes one at a time, then B-SMALL ranked by what it unblocks with one writer per file set, then C-LARGE. D-OWNER cards are listed for the owner with the blocker named.

Never under this directive without the owner: deploy or restart of the live collector, copying into bin-native, node esbuild.js on the installed bundle, push, tag, publish, settings edits, anything against the real data directory, deleting uncommitted work, freeing disk outside /tmp.

Board at start: todo 53, human_review 32, backburner 32, dev 22, testing 11, blocked 9, planned 4, ai_review 3, design 2, proposal 1 (169 open). LOCAL-scope cards under .claude/local/design were not listed in the first triage and still need it.

## Approval log

- 2026-10-04T12:48:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
