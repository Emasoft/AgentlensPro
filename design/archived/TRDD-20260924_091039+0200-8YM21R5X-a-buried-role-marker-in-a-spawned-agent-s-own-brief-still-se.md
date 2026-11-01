---
trdd-id: 8YM21R5X
title: A buried role marker in a spawned agent's own brief still self-exempts it from its SubagentStop gate
column: complete
created: 2026-09-24T09:10:39+0200
updated: 2026-11-01T10:13:44+0100
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T09:10:39+0200
related-trdd: BA0DCW98
status: archived
implementation-commits: [e424e236]
---

# A buried role marker in a spawned agent's own brief still self-exempts it from its SubagentStop gate

## Approval log

- 2026-09-24T09:10:39+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-01T10:13:44+0100 — COMPLETE by main-agent@agentlenspro. fix e424e236 reviewed and deployed.

## Defect

declaredRoleOwnTranscript in src/cli/reviewGate.ts is unanchored by design because the harness may prepend boilerplate to the spawned agent's first transcript entry; anchoring it without knowing that shape would deadlock every real review fork.

## NEXT ACTION

Measure the real wrapped shape of a MEASURE/REVIEW agent's own first transcript entry, then anchor declaredRoleOwnTranscript accordingly.

## Notes

2026-09-24: a fork's own first entry arrives as '...</fork-boilerplate>' then 'Your directive: ROLE: REVIEW' on one line (seen by a review fork 2026-09-24, inferred), so the unanchored regex does not even match a fork; forks are exempted by the separate review-fork rule; the residual concerns non-fork subagents such as lean-worker -- measure one real lean-worker transcript's first entry.
2026-10-04: worker wA SKIPPED, not measured. The only in-repo fixtures of a spawned agent's first entry are synthetic (a lean-worker is a raw prompt string, a fork carries a fork-boilerplate preamble); none is a captured real shape, and real transcripts were out of bounds. Anchoring blind could de-exempt real roled agents. Needs one measured real lean-worker first entry first.
2026-10-04: skipped today (commit 90446356 records it): no measured transcript shape exists to anchor the role marker to. Still owed: a measured transcript shape, then the anchoring. Not implemented, no commit recorded.
2026-10-05: TRDD-BA0DCW98 is now recorded as blocked by this card (its box 2 is this card's work), and BA0DCW98 is one of TRDD-YGETIBJS's two blockers. This card has no acceptance checklist and needs one before it can close. It stays in `backburner`: its stated precondition, one measured first transcript entry of a real non-fork worker, is still unmet. Recommendation to the owner, not acted on: move it to `todo` once that measurement exists.
2026-11-01: MEASURED (orchestrator, Claude Code 2.1.316, this session's subagent transcripts). A fresh non-fork worker (cheap-worker, 2 transcripts): first user entry is a plain string holding the brief verbatim, no harness preamble. A fork (2 transcripts): first user entry is [tool_result, text], the text being a fork-boilerplate block then a line 'Your directive: ROLE: REVIEW'; userPromptText returns empty for it, so declaredRoleOwnTranscript never sees a fork. A resumed agent in a new session file: first entry is a tool_result or a SYSTEM NOTIFICATION string, so no role. Consequence: declaredRoleOwnTranscript anchored to the first non-blank line (delegates to declaredRole); the old unanchored behaviour is gone.
2026-11-01: deployed by rebuilding standalone/cli.js at e424e236 (esbuild exit 0, old unanchored regex gone from the bundle, review-gate --directive exit 0)

## Acceptance checklist

- [x] measured on 2 cheap-worker transcripts (background spawns, Claude Code 2.1.316); no non-fork role agent measured
- [x] declaredRoleOwnTranscript anchored to the first non-blank line
- [x] tests for first-line, buried and resumed shapes pass
- [x] mutation kills (old unanchored regex fails the buried-ROLE test)
