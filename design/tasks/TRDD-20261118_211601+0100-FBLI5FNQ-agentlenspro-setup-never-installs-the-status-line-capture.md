---
trdd-id: FBLI5FNQ
title: agentlenspro setup never installs the status line capture
column: backburner
status: tasked
created: 2026-11-18T21:16:01+0100
updated: 2026-11-18T23:45:37+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: false
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T21:16:01+0100
---

# agentlenspro setup never installs the status line capture

Found 2026-11-18 while planning TRDD-YL3EWT6N item 8 (facts: reports_dev/sonnet-worker/20261118_w54-yl-items-8-10-facts/report.md; the item 8 measure claim 4, transcript entry 2cae0ae7#61767: grep of statusline in setup.ts and autoSetup.ts had no hits). The only writer of statusLine and subagentStatusLine is installStatusline, reached only through the explicit --install-statusline verb (diagnosticsCli.ts:669-670). So a fresh machine has no status line capture after agentlenspro setup, and the first-run auto-setup does not install it either. Item 8b adds a setup step that only REFRESHES a stale stamp of ours: it never creates a missing key and never wraps a foreign command, because the launch check runs on every qualifying verb and would re-create a status line the user removed. Owner order 2026-11-18, verbatim: "status line hook must be digested at all times. disable must never disable the status line hook." That order is about the DISABLED flag; it does not say whether setup should install the status line. OPEN DECISION (owner): should the full agentlenspro setup (explicit verb and first run, not the per-launch repair) install the status line capture, wrapping an existing foreign status line with --inner? If yes, how is a status line the user removed on purpose told apart from one never installed (for example a marker in the data dir written by --uninstall-statusline).

## Approval log

- 2026-11-18T21:16:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T23:55+0100 — approved set to false by main-agent@agentlenspro: the card asks the OWNER a decision (should the full setup install the status line); the trddgrep defaults had marked it approved. Owner answer pending.
