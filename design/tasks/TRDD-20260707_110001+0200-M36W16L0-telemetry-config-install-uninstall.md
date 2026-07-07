---
trdd-id: M36W16L0
title: Safe reversible install/uninstall of Claude Code full-telemetry config (settings.json manager)
column: todo
created: 2026-07-07T11:00:01+0200
updated: 2026-07-07T11:00:01+0200
current-owner: null
assignee: null
priority: 1
severity: HIGH
effort: L
task-type: infra
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: [install-script, config-schema]
external-refs: [https://code.claude.com/docs/en/monitoring-usage]
---

# TRDD-M36W16L0 — Telemetry config install/uninstall manager

## ⏵ STATE — READ FIRST
User: "agentlens at install time must add those config env var to the claude config settings.json …
make sure it can safely and automatically install/uninstall everything without breaking the claude
configuration … when agentlens is working, it must enable the full telemetry power of claude code."

**Done manually this session (to reproduce programmatically):** added to `~/.claude/settings.json` `env`:
`OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORT_INTERVAL=5000`,
`OTEL_METRIC_EXPORT_INTERVAL=10000`, `OTEL_LOG_ASSISTANT_RESPONSES=1`,
`OTEL_LOG_RAW_API_BODIES=file:/Users/emanuelesabetta/.agentlens/otel-bodies` (user already had
CLAUDE_CODE_ENABLE_TELEMETRY, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, endpoint 4318, http/json,
OTEL_LOG_TOOL_CONTENT/DETAILS, OTEL_LOG_USER_PROMPTS, OTEL_TRACES_EXPORTER). Backup:
`~/.claude/settings.json.bak-otel-*`. **AgentLens's collector accepts only http/json OTLP on 4318.**

## Spec
1. `src/telemetryConfig.ts`: `ensureTelemetryConfig()` + `removeTelemetryConfig()`.
   - Read `~/.claude/settings.json` (create `{}` if missing). ATOMIC write (temp+rename). Timestamped
     backup before any write.
   - Merge ONLY the AgentLens-owned keys into `env` (endpoint=http://localhost:${OTLP_PORT}, protocol
     http/json, the exporters + gates + raw-body dir). Do NOT overwrite a key the user already set to a
     DIFFERENT value without recording it.
   - Write a managed-keys MARKER at `~/.agentlens/telemetry-managed.json` recording, per key: whether
     AgentLens added it and the PRIOR value (or absent). `removeTelemetryConfig()` restores exactly:
     re-set prior values / delete keys AgentLens added. Never touch non-owned keys. Idempotent both ways.
   - Create the raw-body dir (`~/.agentlens/otel-bodies`) on install.
2. **Wire into server start** (`standalone/server.ts` / cli): on start call `ensureTelemetryConfig()`
   unless `AGENTLENS_NO_TELEMETRY_CONFIG=1`; log what it changed. Provide `agentlens telemetry
   install|uninstall|status` CLI subcommands (standalone/cli.ts).
3. **Restart notice**: settings.json env changes only apply to NEW CC sessions — the server MUST print a
   clear "restart your Claude Code sessions for telemetry to take effect" line after an install that
   changed anything.
4. Unit tests: install→marker correct→uninstall restores byte-identical env (minus AgentLens keys);
   idempotent re-install; never clobbers a user's differing value (records + restores it).

## Acceptance
- `agentlens telemetry install` then `uninstall` leaves settings.json env exactly as before (proven by
  a fixture). Server auto-ensures on start (opt-out honored). Never writes invalid JSON. Unit tests pass.
- Also handles the hooks the user mentioned IF any are genuinely needed (evaluate: AgentLens ingests via
  OTLP + jsonl tail, so likely NO CC hook is required — document that finding rather than adding a no-op hook).
