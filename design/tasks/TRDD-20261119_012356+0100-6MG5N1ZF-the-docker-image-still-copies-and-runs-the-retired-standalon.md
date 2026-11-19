---
trdd-id: 6MG5N1ZF
title: The Docker image still copies and runs the retired standalone server bundle
column: todo
status: tasked
created: 2026-11-19T01:23:56+0100
updated: 2026-11-19T01:37:26+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:23:56+0100
---

# The Docker image still copies and runs the retired standalone server bundle

Split out of TRDD-YL3EWT6N (its OPEN item "the Dockerfile repair") on 2026-11-19 as a release blocker of TRDD-HSPUF5XH. Facts (harness measure 2026-11-19): .github/workflows/docker.yml runs on every v* tag push (lines 3-6); Dockerfile line 39 copies /app/standalone/server.js and line 65 runs `node standalone/server.js`; git ls-files lists neither standalone/server.js nor standalone/server.ts (the TypeScript server was retired in 567fc5c2). That the image build fails or ships a broken image is INFERRED; the build was not run. HSPUF5XH line 211 also names a missing target-platform alcore build, media/index.html and sidebar.js in the image.

## Acceptance
- [ ] The Dockerfile builds and starts alcore (the only server) for the image platform, with the dashboard assets it serves.
- [ ] A local `docker build` of the release tree succeeds, and the container answers on its UI and OTLP ports (or the reason a local build cannot run here is recorded and CI docker.yml is run by workflow_dispatch instead).
- 2026-11-19T01:37:23+0100 main agent notes: (1) The local check (W74) builds linux/arm64 natively while docker.yml will ship linux/amd64 only, so the amd64 image (TARGETARCH amd64, bin-native/linux-x64) is UNVERIFIED until docker.yml runs; run it by workflow_dispatch before the tag. (2) Why not stage the prebuilt bin-native binaries of publish.yml (named by two harness reviews of W72): docker.yml is a separate workflow started by the same tag, and a workflow run cannot download another run's artifacts without a cross-run artifact lookup that neither workflow has; compiling in the image keeps docker.yml self-contained. (3) The docs gate owes one CHANGELOG/README line: the image is linux/amd64 only until TRDD-6J96UCTJ. (4) The user rule github.md asks to update outdated action versions in a touched workflow: the action pins of docker.yml are to be checked (gh api releases/latest per action, then pinact) before this card closes.

## Approval log

- 2026-11-19T01:23:56+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
