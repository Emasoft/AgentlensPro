---
trdd-id: TABN063T
title: server status must not print NOT RUNNING for a live but busy server
column: published
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T12:34:19+0200
implementation-commits: [64c4d94]
current-owner: AgentlensPro session
task-type: bugfix
severity: MEDIUM
labels: [cli, diagnostics]
relevant-files: [standalone/cli.ts, src/cli]
release-via: publish
---

# `server status` false negative under load

Printed `NOT RUNNING` while the server was live and listening on 3000/4316/4318
(lsof-confirmed) — the 800ms connect timeout loses to a busy/GC-thrashing server, and the
command's own next line contradicts it from the pidfile. A diagnostic that lies under exactly
the load it exists to diagnose is worse than none.

Fix direction: make the verdict coherent — pidfile-alive (kill -0) + listener evidence must not
be overridden by one short connect timeout; a timed-out probe on a live pid reports
RUNNING (busy / not responding within Nms), never NOT RUNNING. Keep fail-fast semantics.

## Acceptance

- [x] a live-but-slow server is never reported NOT RUNNING (test with a deliberately stalled listener — worker report reports/cli-hardening/20260818_115432+0200-strict-flags-and-status.md)
- [x] a genuinely dead server still reports NOT RUNNING with a non-zero exit
- [x] output remains script-parseable; check-types + lint green (commit 64c4d94, suite 2368 passing)

## Approval log

- 2026-08-18T12:28:36+0200 — APPROVED human_review → complete by USER (batch "approved."). Live re-verify at approval: `server status` → `RUNNING pid=5888 ... canonical=true` in one coherent verdict line. Ships in v2.27.0 (release-via: publish; → published on tag).
- 2026-08-18T12:34:19+0200 — PUBLISHED as agentlenspro@2.27.0 (tag v2.27.0, workflow run 32127117865, OIDC trusted publisher, SLSA provenance verified on registry). Archived as published.
