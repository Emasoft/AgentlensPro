---
trdd-id: 8S104SPF
title: The review-gate worker scan may re-list a resumed worker's earlier writes at every return
column: todo
status: tasked
created: 2026-11-19T23:45:41+0100
updated: 2026-11-20T00:11:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:45:41+0100
---

# The review-gate worker scan may re-list a resumed worker's earlier writes at every return

INFERRED by the BQC0IA74 triage (reports_dev/review-gate-issues/20261119-triage.md): workerWriteDetail rescans the WHOLE worker transcript at every return (src/cli/reviewGate.ts:542-575), so a worker resumed by SendMessage that returns again with no new write may re-report its first-run writes as work. Probe first: resume a writing worker, let it return with no new write, run agentlenspro review-gate --json-verdict on that notification turn, read work.detail. Fix if confirmed: scan only entries after the line count recorded at the previous return of the same tool-use id. Overlaps NEC3PBYU defect 2.

## Approval log

- 2026-11-19T23:45:41+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20T00:06+0100 residual from TRDD-1ZVRZGF1, decided by the main agent: gh api graphql with a quoted query value that holds an expansion mid-value (query="$Q { x }", query="$A$B") is judged on its literal text and reads as a PASS (fail-open). Hiding every $ was rejected because parameterized GraphQL reads (query($o: String!)) would then count as writes. Fix idea: have shellWords report whether a $ sat in single quotes (literal) or in double quotes/unquoted (an expansion) and hide only the expansion case.
2026-11-20T00:11+0100 the previous line (the gh api quoted mid-value residual) was filed here by mistake: it is not this card's subject. It now has its own card (see the trddgrep new output of 2026-11-20T00:11+0100, title starting 'gh api graphql with an expansion in the middle'). Ignore it on this card.
2026-11-20T00:11+0100 the misfiled residual now lives on TRDD-6OM9SMLC.
