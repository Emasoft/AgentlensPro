---
trdd-id: CODXTOML1
title: Codex auto-configure writes a duplicate otel exporter table and the edit is refused
column: complete
created: 2026-08-13T12:57:16+0200
updated: 2026-08-18T13:15:00+0200
implementation-commits: [240189b]
current-owner: agentlenspro-session
task-type: bugfix
---

Observed live 2026-08-13 (server.log): "Could not auto-configure Codex: edited TOML no longer parses: Cannot declare ('otel', 'exporter', 'otlp-http') twice (at line 12, column 25)". The safeConfigEdit verify-diff gate correctly REFUSED the broken write (the guard held; no user config was damaged), but the Codex TOML generator produces a duplicate table declaration when the config already carries one. Fix the generator to merge-or-skip an existing table; test with a config that already has the table. Until fixed, Codex telemetry auto-config silently stays unconfigured on such configs.

## Approval log

- 2026-08-18T13:15:00+0200 — APPROVED by USER (batch "complete all TRDD") and IMPLEMENTED in
  240189b. Root cause was in `scripts/safe_config_edit.py::ensure_line_in_section`, not the op
  list: the inline-line scan cannot see a key declared as a sub-table header, so it inserted the
  inline twin. Fix consults the parsed tree first — a key present in ANY form is skipped (the
  user's explicit config is never fought). Two red-first tests (sub-table with and without the
  bare [otel] header) fail 2/2 pre-fix, pass 2/2 post-fix. Column → complete; rides the next
  publish.
