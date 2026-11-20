---
trdd-id: 6J96UCTJ
title: The Docker image has no linux arm64 build until a native arm64 runner is added
column: backburner
status: tasked
created: 2026-11-19T01:34:21+0100
updated: 2026-11-19T01:37:27+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:34:21+0100
---

# The Docker image has no linux arm64 build until a native arm64 runner is added

Filed 2026-11-19 from TRDD-6MG5N1ZF. The rewritten Dockerfile compiles alcore (bundled DuckDB, thin LTO) inside the image. Under docker.yml the linux/arm64 leg would run that compile under QEMU on ubuntu-latest, which is very likely to exceed the job timeout (INFERRED, not measured; W72 report reports_dev/sonnet-worker/20261119_w72-dockerfile/report.md, open item 1). For the 2026-11-19 release docker.yml builds linux/amd64 only. This card restores an arm64 image built natively.

## Acceptance
- [ ] docker.yml builds the arm64 image on a native arm64 runner (as publish.yml build-binaries does with ubuntu-24.04-arm) and publishes one multi-arch manifest with amd64.
- [ ] One run of the workflow is green, with its duration recorded.

## Approval log

- 2026-11-19T01:34:21+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
