---
trdd-id: A88PF0WA
title: The Docker image logs a failed bodies sink at every start because /data/otel-bodies is never created
column: backburner
status: tasked
created: 2026-11-20T05:59:46+0100
updated: 2026-11-20T06:00:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T05:59:46+0100
---

# The Docker image logs a failed bodies sink at every start because /data/otel-bodies is never created

## Approval log

- 2026-11-20T05:59:46+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Found by the TRDD-6MG5N1ZF post-release probe of ghcr.io/emasoft/agentlenspro:2.34.0 (linux/amd64, digest sha256:674c8341298bc5f442c526db4611a25dbfee68307f78582a64f5391a610e6f2e), report reports_dev/6MG5N1ZF/20261120_055157+0100-amd64-image-probe.md. One second after boot the container logs: 'alcore: bodies sink precondition FAILED: /data/otel-bodies does not exist (volume unmounted?) (TRDD-4FMHW124)'. Mechanism (read at HEAD 0780e836): chores.rs bodies_pass calls server_stats::probe_sink(<data>/otel-bodies) on every pass; probe_sink only reports a missing dir and never creates it (server_stats.rs:425-440); the Dockerfile creates only /data (line 96: RUN mkdir -p /data). Raw bodies are written to that dir by a LOCAL Claude Code (OTEL_LOG_RAW_API_BODIES=file:<dir>), which a container receiving OTLP over the network never has, so in the default container the dir is never created and the failure stays.
Effect, INFERRED not measured: every Docker deployment reports a failed sink (the state is kept in CoreState.sink_problem, which /api/server-stats and the CLI's SINK line read), a false alarm that hides a real one. Serving was not affected in the probe: UI and OTLP answered 200 after the line. Not checked: whether a native fresh install shows the same line before its first raw body arrives (agentlenspro setup may create the dir), and whether any ingestion path writes into otel-bodies inside the container.

## Acceptance

- [ ] Decide where the dir is made: in the Dockerfile (mkdir -p /data/otel-bodies, owned by agentlens) or by alcore at boot; record why.
- [ ] A container started from the fixed image logs no 'bodies sink precondition FAILED' line, and /api/server-stats reports no sink problem.
- [ ] The answer for a native fresh install (same line or not) is recorded.
