---
trdd-id: P782D69Q
title: Corpus - EHT children carry parent-trdd and lack derived true; CLAUDE.md fork-default wording misleads
column: todo
status: tasked
created: 2026-10-17T08:33:09+0200
updated: 2026-10-17T08:33:09+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T08:33:09+0200
---

# Corpus - EHT children carry parent-trdd and lack derived true; CLAUDE.md fork-default wording misleads

Two corpus-level items found 2026-10-17. (1) Lint DERIVED-FLAG-MISSING groups 12 EHT cards. `trddgrep fix --dry-run` on N6A8VX3G adds derived: true but leaves the finding count at 2, because those cards also carry parent-trdd, which the TRDD rule forbids on derived cards. Needs one decision for the whole group, not per-card patches. (2) CLAUDE.md doctrine 5 says '>=2.1.232 makes fork spawning the default'. Per https://code.claude.com/docs/en/sub-agents, 2.1.232 makes fork MODE the interactive default; an Agent call with no subagent_type still gets general-purpose, and a fork is requested as subagent_type fork. The wording led to the false lead TRDD-OXHMLJCG. CLAUDE.md has another session's uncommitted edits, so fix the wording when it is next committed.

## Approval log

- 2026-10-17T08:33:09+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
