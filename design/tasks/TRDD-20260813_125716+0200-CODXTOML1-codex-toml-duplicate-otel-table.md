---
trdd-id: CODXTOML1
title: Codex auto-configure writes a duplicate otel exporter table and the edit is refused
column: backburner
created: 2026-08-13T12:57:16+0200
updated: 2026-08-13T12:57:16+0200
current-owner: agentlenspro-session
task-type: bugfix
---

Observed live 2026-08-13 (server.log): "Could not auto-configure Codex: edited TOML no longer parses: Cannot declare ('otel', 'exporter', 'otlp-http') twice (at line 12, column 25)". The safeConfigEdit verify-diff gate correctly REFUSED the broken write (the guard held; no user config was damaged), but the Codex TOML generator produces a duplicate table declaration when the config already carries one. Fix the generator to merge-or-skip an existing table; test with a config that already has the table. Until fixed, Codex telemetry auto-config silently stays unconfigured on such configs.
