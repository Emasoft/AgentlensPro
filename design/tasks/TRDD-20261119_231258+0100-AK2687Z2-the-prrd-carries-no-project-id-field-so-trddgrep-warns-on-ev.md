---
trdd-id: AK2687Z2
title: The PRRD carries no project-id field so trddgrep warns on every card write
column: todo
status: tasked
created: 2026-11-19T23:12:58+0100
updated: 2026-11-19T23:32:51+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:12:58+0100
---

# The PRRD carries no project-id field so trddgrep warns on every card write

Every trddgrep new on 2026-11-19T23:12+0100 printed: 'no project-id: design/requirements/PRRD.md carries no project-id field'. Next: read prrdgrep help for how the field is set (frontmatter, not a rule), add project-id agentlenspro, confirm the warning is gone.

## Approval log

- 2026-11-19T23:12:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Done

2026-11-19T23:16+0100: prrdgrep edit G1.1 --at-line 4 set 'project: agentlenspro' (was unnamed-project) and added 'project-id: agentlenspro'; prrdgrep lint clean. Commit with the v2.34.0 docs commit, then close.
2026-11-19T23:25+0100 verified: trddgrep lint prints no project-id line (count 0). The same edit also renamed 'project: unnamed-project' to 'project: agentlenspro': the placeholder was never a real name and every tool that prints the project name showed it. PRRD updated: bumped through prrdgrep.
2026-11-19T23:29+0100 correction: lint never printed the warning, so 'lint count 0' proved nothing. The warning came from trddgrep new; the next new card created after the edit is the real check.
2026-11-19T23:32+0100 verified: trddgrep new A79CZ8JH (23:30:46, after the PRRD edit) printed no project-id warning; before the edit every new printed it.
