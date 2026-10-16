---
trdd-id: LZ2JDIJP
title: The SubagentStop review gate never sees a worker's own entries so worker writes are never reviewed
column: ai_review
status: tasked
created: 2026-10-03T03:57:21+0200
updated: 2026-10-16T11:13:24+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T03:57:21+0200
---

# The SubagentStop review gate never sees a worker's own entries so worker writes are never reviewed

BUG: src/cli/reviewGate.ts scanTranscriptLines does 'if (e?.isSidechain === true) continue'. A subagent's OWN transcript has isSidechain:true on EVERY user/assistant entry (all carry agentId = that subagent's id), so runSubagentGate (SubagentStop) scans nothing and always allows. Measured (docs_dev/20261003_035608+0200-sidechain-gate-measure.md): of 387 writing subagents since 2026-09-15, 382 were never reviewed; 8722 subagent files, 4838 100% isSidechain; main transcripts contain 0 sidechain entries. FIX: scanTranscriptLines(lines, cwd, ownAgentId?) skips an isSidechain entry only when its agentId differs from ownAgentId (undefined for the main gate, behaviour unchanged); runSubagentGate passes input.agent_id; a worker's nested grandchildren stay excluded. DONE WHEN: tests for own-sidechain block, grandchild allow, role mid-sentence vs whole-line, main gate unchanged; real-data replay over transcripts since 2026-09-15 reports block counts.

## Approval log

- 2026-10-03T03:57:21+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-16T11:13:24+0200 — column → ai_review by main-agent@agentlenspro. code on main (fix 24094e57), verification not recorded; the main agent verifies next; triage row 5
