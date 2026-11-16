---
trdd-id: 2MX4LWPF
title: A test leaks an alcore server that outlives the suite
column: backburner
status: tasked
created: 2026-10-29T18:05:24+0100
updated: 2026-10-29T18:05:24+0100
current-owner: main-agent@AgentlensPro
created-by: main-agent@AgentlensPro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@AgentlensPro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@AgentlensPro
approval-datetime: 2026-10-29T18:05:24+0100
---

# A test leaks an alcore server that outlives the suite

An alcore serve process with parent pid 1, data dir under the OS temp dir named al-setup-<random>/.agentlens and ports 5442x, started 2026-10-28 23:00, was still running 18 hours later. Some test that starts a server via setup does not stop it in every path. Find the test (grep the tests for al-setup-), make its teardown stop the server in a finally, and add a check that the process table after the suite matches the one before. Owner decides whether to stop the leaked process.

## Approval log

- 2026-10-29T18:05:24+0100 — MANDATE issued by main-agent@AgentlensPro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
