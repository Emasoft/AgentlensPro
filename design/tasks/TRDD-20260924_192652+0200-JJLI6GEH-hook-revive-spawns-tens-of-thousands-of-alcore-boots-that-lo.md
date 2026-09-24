---
trdd-id: JJLI6GEH
title: hook-revive spawns tens of thousands of alcore boots that load the span store before the pid lock
column: todo
status: tasked
created: 2026-09-24T19:26:52+0200
updated: 2026-09-24T19:26:52+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-24T19:26:52+0200
---

# hook-revive spawns tens of thousands of alcore boots that load the span store before the pid lock

OWNER-ADJACENT evidence, orchestrator, 2026-09-24, measured over the whole ~/.agentlens/server.log: 40,735 "boot provenance" lines total, 40,731 of them started-by=hook-revive. Of those, 40,316 are immediately followed by a "loaded N span(s)" line (the span store is loaded into memory) and only 201 are followed by an explicit "Refusing to start: another AgentlensPro server ... owns this data directory" pid-lock refusal. So hook-revive is spawning tens of thousands of alcore processes that load the span store before, or instead of, meeting the pid lock that is supposed to keep exactly one server owning the data directory (pid_lock.rs claim/release, keyed on data dir, per CLAUDE.md). Open question to answer FIRST: does the pid-lock check run strictly after the span-store load in the boot sequence (so every one of the ~40k non-refused boots genuinely loaded the store before being told to exit, wasting the load and creating a window where two processes both hold the store in memory), or is "loaded N span(s)" logged by a process that then exits cleanly on the lock check with no dedicated refusal line (making the 201:40316 ratio not a measure of contention at all)? Read pid_lock.rs::claim and the alcore.rs boot sequence in order before proposing a fix. Related: TRDD-WKLD508O (this card documents hook-revive as the restart mechanism with no supervisor).

## Approval log

- 2026-09-24T19:26:52+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
