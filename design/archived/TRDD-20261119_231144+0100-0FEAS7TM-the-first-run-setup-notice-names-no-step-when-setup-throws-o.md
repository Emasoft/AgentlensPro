---
trdd-id: 0FEAS7TM
title: The first-run setup notice names no step when setup throws outside the step loop
column: cancelled
status: archived
created: 2026-11-19T23:11:44+0100
updated: 2026-11-19T23:13:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:11:44+0100
---

# The first-run setup notice names no step when setup throws outside the step loop

c92d5bdc makes the first-run notice name the first FAIL row (src/cli/autoSetup.ts firstFailedStep). runSetup (src/cli/setup.ts:1932) turns a throwing STEP into a FAIL row (loop 1941-1957), but a throw in resolveCtx, printDetection or renderTable escapes the loop; then no row exists and the notice says only 'first-run setup failed'. Fix: catch around runSetup in defaultFullSetup and report failed='setup: <message>'; add a test with a throwing resolveCtx. Found 2026-11-19T23:11+0100.

## Approval log

- 2026-11-19T23:11:44+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T23:13:06+0100 — CANCELLED by main-agent@agentlenspro. premise wrong: the outer catch at autoSetup.ts:457 already names the error.

## Correction

2026-11-19T23:13+0100: premise WRONG. maybeAutoSetup has an outer catch (src/cli/autoSetup.ts:457-460) that prints 'agentlenspro: auto-repair failed (<message, 160 chars>) — run agentlenspro setup' for any throw, including one from runSetup outside its step loop. The error IS named; only the wording says auto-repair instead of first-run setup. No defect worth a change; cancelled.
