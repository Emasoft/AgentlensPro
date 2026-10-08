---
trdd-id: 0TMX5I4O
title: Test-instance alcore ignores SIGTERM - three occurrences make it a pattern
column: backburner
status: tasked
created: 2026-10-08T18:40:18+0200
updated: 2026-10-08T18:40:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-08T18:40:18+0200
---

# Test-instance alcore ignores SIGTERM - three occurrences make it a pattern

Test alcore instances repeatedly survive SIGTERM within a normal wait: the orphan pair (pids 32797, 50556, 2026-10-05, the permission classifier refused the kill), and PQ40PZ9D's run (pid 43823, 2026-10-08 — SIGTERM did not stop it within ~2s; SIGKILL did; Z0A777XW's pid 67024 stopped fine, so it is conditional, not universal). Hypotheses: the sweeper/statusline threads do not observe the shutdown signal under load, pid_lock's owner-checked release gates a clean exit the test flow never reaches, or the signal handler defers to a grace period longer than the test's wait. First step: read bin/alcore.rs's signal setup and the shutdown path; then reproduce with SIGTERM + strace-equivalent (dtruss won't run on modern macOS — use the server log's shutdown lines) against an isolated instance. related: [PQ40PZ9D, Z0A777XW].

## Approval log

- 2026-10-08T18:40:18+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
