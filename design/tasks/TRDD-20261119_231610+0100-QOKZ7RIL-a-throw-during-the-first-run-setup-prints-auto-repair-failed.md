---
trdd-id: QOKZ7RIL
title: A throw during the first-run setup prints auto-repair failed instead of first-run setup failed
column: todo
status: tasked
created: 2026-11-19T23:16:10+0100
updated: 2026-11-19T23:25:39+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:16:10+0100
---

# A throw during the first-run setup prints auto-repair failed instead of first-run setup failed

Split from 0FEAS7TM (cancelled 2026-11-19T23:16+0100). ensureInstalled's outer try (src/cli/autoSetup.ts:304) catches at 457 and prints 'agentlenspro: auto-repair failed (<message>)'. A throw from runSetup on the first-run path (line 411) therefore reads as an auto-repair, not as the first-run setup the user just triggered. Fix: catch around the fullSetup call at 411 and return {ok:false, failed:'setup: <message>'} so the first-run notice covers it; test with a throwing fullSetup dep.

## Approval log

- 2026-11-19T23:16:10+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Decisions

2026-11-19T23:25+0100: supersedes 0FEAS7TM's Correction, which named maybeAutoSetup; the outer try is in ensureInstalled (autoSetup.ts:304, catch 457), and the wording IS a defect. Behaviour change, deliberate: a throw now becomes ok:false, so with telemetry conflicts the command returns EXIT.CONFIG exactly like a setup that fails without throwing; with no conflicts it still returns null and the verb runs. Fix applied in worktree /private/tmp/wt-causing-sort (src/cli/autoSetup.ts, +6 -1); test pending.
