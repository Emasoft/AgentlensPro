---
trdd-id: PIB6T4RU
title: unknown flags must exit 64 on every CLI entry point
column: dev
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T11:43:42+0200
current-owner: AgentlensPro session
task-type: bugfix
severity: MEDIUM
labels: [cli]
relevant-files: [standalone/cli.ts, src/cli]
release-via: publish
---

# Unknown flags must exit 64 on every CLI entry point

`list`, `server status`, `statusline-history project` accept `--definitely-not-a-real-flag`,
ignore it, and exit 0. `last-compact` / `cache-expired` correctly exit 64 — the strict parser
already exists; the work is enumerating EVERY entry point and routing it through (only 5 were
sampled in the audit). Fail-fast: unknown flag → usage line on stderr → exit 64.

## Acceptance

- [ ] every subcommand rejects an unknown flag with exit 64 (enumerated, not sampled)
- [ ] known flags/behavior unchanged; `pnpm run check-types` + lint green
- [ ] a test covers at least the previously-broken three
