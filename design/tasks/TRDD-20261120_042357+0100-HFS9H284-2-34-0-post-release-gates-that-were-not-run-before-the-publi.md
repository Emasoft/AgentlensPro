---
trdd-id: HFS9H284
title: 2.34.0 post-release gates that were not run before the publish
column: todo
status: tasked
created: 2026-11-20T04:23:57+0100
updated: 2026-11-20T06:08:10+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: audit
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T04:23:57+0100
---

# 2.34.0 post-release gates that were not run before the publish

TRDD-HSPUF5XH published 2.34.0 on 2026-11-20 (publish run 44657500944) with these release gates not met; they move here so they are not dropped. Evidence per box: reports_dev/HSPUF5XH/20261120_041919+0100-open-boxes.md. Live and full-corpus gates are OWNER-GATED: the owner keeps the collector stopped (~/.agentlens/DISABLED and NO_REVIVE); do not start the live server for them without the owner. Acceptance: (1) cargo test --workspace green on the released tree, in CI or locally (main CI rust job timed out, TRDD-2LXKMRE3). (2) 15-minute hold read on a 2.34.0 alcore per the O3ICDRLO recipe: no burn-tick state-lock hold line of 250 ms or more (never measured, HSPUF5XH l.399). (3) Upgrade boot from a v2.33.1 data dir on a full corpus with the 2.34.0 alcore: peak RSS against the 2048 MB cap and the cold rescan finishing (only a sample boot ran, HSPUF5XH l.321-326). (4) Live server on 2.34.0: the running pid executes the released binary, and the api_call table fills from posted bodies (owner-gated). (5) pnpm run compile at the released tree, locally (CI ran most of its sub-checks only).

## Approval log

- 2026-11-20T04:23:57+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20: Docker post-release check (handed off by TRDD-HSPUF5XH, tracked on TRDD-6MG5N1ZF): docker.yml run 44651312460 on v2.34.0 succeeded; the published ghcr.io/emasoft/agentlenspro:2.34.0 for linux/amd64 (emulated on an aarch64 host) starts alcore, answers GET / (200) and /dashboard.js (200, 464,401 bytes), and accepts an empty OTLP POST (200); health reads healthy. Open: /sidebar.js and /dashboard.css (probe dispatched), ingestion with a real span. Defect found: the image never creates /data/otel-bodies, so every start logs a failed bodies sink (TRDD-A88PF0WA). Report: reports_dev/6MG5N1ZF/20261120_055157+0100-amd64-image-probe.md.
2026-11-20: Docker asset follow-up (supersedes 'open: /sidebar.js and /dashboard.css' above): a fresh emulated-amd64 container of the published 2.34.0 image returned 200 for /, /dashboard.js, /dashboard.css, /sidebar.js, /help-mascot.png and /mascot.png, each with its own size and content type (report reports_dev/6MG5N1ZF/20261120_060452+0100-amd64-assets.md). Scope: the page's script and link tags; img, runtime and CSS url() references not probed. Still open: ingestion with a real span, and TRDD-A88PF0WA.
