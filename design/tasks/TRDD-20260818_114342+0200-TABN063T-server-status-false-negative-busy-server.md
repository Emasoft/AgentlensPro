---
trdd-id: TABN063T
title: server status must not print NOT RUNNING for a live but busy server
column: dev
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T11:43:42+0200
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

- [ ] a live-but-slow server is never reported NOT RUNNING (test with a deliberately stalled listener)
- [ ] a genuinely dead server still reports NOT RUNNING with a non-zero exit
- [ ] output remains script-parseable; check-types + lint green
