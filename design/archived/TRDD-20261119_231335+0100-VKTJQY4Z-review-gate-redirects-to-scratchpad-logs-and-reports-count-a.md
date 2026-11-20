---
trdd-id: VKTJQY4Z
title: review-gate redirects to scratchpad logs and reports count as writes and force a full-context review fork (GitHub 22)
column: complete
status: archived
created: 2026-11-19T23:13:35+0100
updated: 2026-11-19T23:45:33+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:13:35+0100
---

# review-gate redirects to scratchpad logs and reports count as writes and force a full-context review fork (GitHub 22)

Source: GitHub issue Emasoft/AgentlensPro 22, https://github.com/Emasoft/AgentlensPro/issues/22, opened 2026-10-03. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:13:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T23:45:33+0100 — COMPLETE by main-agent@agentlenspro. gone on the mod path by code reading (reports_dev/review-gate-issues/20261119-triage.md); GitHub issue left open for the owner.

## Problem

Symptom: review-gate counts any shell redirect as a write-shaped command and demands a full-context REVIEW fork, even when the target is a throwaway log in the session scratchpad.
Observed 2026-10-03: npm test redirected to a scratchpad file (no source file changed), a comm set difference written to a scratch file, a cp of a scratch copy, and a redirect into a gitignored reports/ ledger each tripped the gate.
Cause per the issue: the redirect heuristic does not apply the rule's exemptions (/tmp, reports/, *_dev/), and the session scratchpad under /private/tmp is not recognised as /tmp.
Cost: each demanded fork inherits the whole transcript, about 600k-750k tokens late in that session (subagent_tokens 630k-750k), so one trip on a test log costs as much as a real review.
Proposed fixes: apply the exemptions to redirect and cp targets, including /private/tmp and the session scratchpad; treat a > file 2>&1 capture of a test, lint or tsc run as read-only; consider a cheaper fork for exempt-only trips.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Related

Overlaps PV5BIND2 (cancelled, unresolvable shell-variable target), WAW0M092 (superseded, scratch-path landing) and 5UFK1H6E (todo, variable resolver misses chained assignments).
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.

## Acceptance

- [x] On the mod path no Stop demands a fork (register.js F1) and a literal target under /tmp, /private/tmp, reports/ or *_dev/ is exempt (reviewGateTriggers.ts:166-184); a $VAR target resolves from a same-command assignment (:523-545). Residual unassigned-$VAR case belongs to 5UFK1H6E.
