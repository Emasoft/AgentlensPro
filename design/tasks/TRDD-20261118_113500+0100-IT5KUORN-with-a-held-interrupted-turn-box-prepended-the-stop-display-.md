---
trdd-id: IT5KUORN
title: With a held interrupted-turn box prepended the Stop display cuts the report of the current turn
column: todo
status: tasked
created: 2026-11-18T11:35:00+0100
updated: 2026-11-18T11:35:00+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T11:35:00+0100
---

# With a held interrupted-turn box prepended the Stop display cuts the report of the current turn

## Problem
Review mod (agentlenspro-review-mod). When the Stop display carries a held interrupted-turn box, the review report of the CURRENT turn is cut from what the user sees. Seen in probe 1 of TRDD-ISEF8YO7 (mod 0.7.12, Claude Code 2.1.327, terminal): the user saw the old report whole, 3 rows of its usage table, the marker "report truncated", then the usage box of the current turn. The status line said review PASS. On a BLOCK turn the user display would lose the blocking findings (the model still gets them).

## Evidence
- reports_dev/mods-expert-developer-agent/20261118_isef8yo7-boxes.md, finding F1 (read whole by the main agent). Raw files reports_dev/ISEF8YO7/raw/80-p1-*.
- By that report, not read by the main agent: register.js:1406 unshifts the held lines; hooks/show.py fit() (:71, loop :90-94) trims the head from its END, where the current report sits; the payload is measured after json.dumps, where each box glyph costs 6 characters (stdout 8,814 characters for a 4,572-character message; BUDGET 9000 at :35).
- Not new in 0.7.12: 0.7.10 does the same unshift at :1320-1322 with a sha256-equal show.py (by code, not seen on 0.7.10). 0.7.12 makes it reachable after a compaction.

## Fix options (leads for the mods agent, not decisions)
1. register.js:878 hold the heading and the report without usageTable(table); the row at :882 already carries cost and tokens.
2. show.py: ensure_ascii=False in the json.dumps calls of fit() and main(), after measuring that the 10,000 cap of hook output counts characters.
3. fit(): cut held lines before lines of the current report.

## Owner directive
Mod work is designed, written and tested by the agent mods-expert-developer-plugin:mods-expert-developer-agent (owner, 2026-11-18). The main agent writes no mod code.

## Acceptance
- [ ] With one held box and a current report that together exceed the budget, the Stop display keeps the verdict and the findings of the CURRENT turn.
- [ ] A test or a probe shows it for a BLOCK verdict.
- [ ] The mod version is bumped.

## Approval log

- 2026-11-18T11:35:00+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
