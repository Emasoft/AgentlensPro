---
trdd-id: L7ATB1KQ
title: alcore CLI FAIL surface is empty-detail and server-facing commands cannot distinguish a dead server from a dead probe (janitor bug report 2026-09-27)
column: backburner
status: tasked
created: 2026-09-27T05:47:01+0200
updated: 2026-09-27T05:48:32+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-27T05:47:01+0200
---

# alcore CLI FAIL surface is empty-detail and server-facing commands cannot distinguish a dead server from a dead probe (janitor bug report 2026-09-27)

## Approval log

- 2026-09-27T05:47:01+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
VERIFIED FACTS 2026-09-27 (janitor bug report + this session's reproduction). (1) Server was down in the RSS crash loop (root fix = TRDD-2JOIAH2G; not this card). (2) REPRODUCED: list/get_recent_sessions/--help print 'FAIL: cannot reach http://localhost:4316/mcp:' with EMPTY detail — connect-error text swallowed; --help makes a server call at all. (3) REPRODUCED: status names localhost:3000 while tools probe localhost:4316/mcp — both legit endpoints per CLAUDE.md, not config drift, but two different 'alive' answers with no canonical health notion. (4) Hook spool backed up while down (48 events), drained to 0 after restart — drain works; the gap is no CLI surface says 'spool backing up because server down'. (5) 'diagnostics session' is not a real command; empty-detail FAIL reproduces on real tools. FIX ITEMS — L1: every FAIL line carries non-empty detail (errno + URL; fallback 'connection failed (no detail)'). L2: --help and offline surfaces never probe the server. L3: tool errors point at 'agentlenspro server status' for the canonical health view + 'server start' remedy. L4: ECONNREFUSED (nothing listening) vs timeout (hung) get different words. NON-GOALS: the crash loop itself; the spool drain mechanism (only visibility, folded into L3).
