---
trdd-id: KZCSO0R2
title: Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review
column: todo
status: tasked
created: 2026-11-11T16:24:22+0100
updated: 2026-11-12T11:13:23+0100
implementation-commits: [42b140f5, 43baaf9b, dd79f249]
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-11T16:24:22+0100
---

# Convert review-gate enforcement to mods so an interrupt can never skip the adversarial review

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-12

- Phase 0 (--json-verdict + --transcript argv branch): COMMITTED — 42b140f5 (flag + stdin path), 43baaf9b (--transcript branch). Reviewed: accepted.
- Phase 1 (mod scaffold agentlenspro-review-mod/): COMMITTED — dd79f249. Reviewed: accept-with-conditions, scaffold is INERT (not installed, no settings.json changes).
- NEXT ACTION: live probe (design step 6) — run `claude --plugin-dir /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/agentlenspro-review-mod --debug` in a scratch project; interrupt a writing turn with Esc; confirm (a) e.transcriptPath exists in the turn.complete event (review F7), (b) whether the second-net scan causes spurious re-demands on compliant turns (review F1).
- Review findings still open on the scaffold: F1 (second-net spurious demands — needs probe or dedup signal), F2 (dead `aborted` var), F3 (verdict() swallows scanner failures silently — surface via $.ui.status), F4 ($.process.run 30s timeout vs gate's 120s), F7 (e.transcriptPath unverified).
- Gotcha: `aborted` var in register.js turn.complete is dead code (computed, never read) — harmless but a fingerprint of an earlier dropped-lines edit; remove when touching the file next.
- SUPERSEDED: none.

## Approval log

- 2026-11-11T16:24:22+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-11T18:37:38+0100 — column → todo by user. design complete (reports_dev/mods-review-gate/20261111_design.md); starting Phase 0 --json-verdict flag
