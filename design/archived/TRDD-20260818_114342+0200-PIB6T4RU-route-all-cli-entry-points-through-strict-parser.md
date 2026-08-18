---
trdd-id: PIB6T4RU
title: unknown flags must exit 64 on every CLI entry point
column: published
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T12:34:19+0200
implementation-commits: [64c4d94]
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

- [x] every subcommand rejects an unknown flag with exit 64 (enumerated, not sampled — worker report reports/cli-hardening/20260818_115432+0200-strict-flags-and-status.md)
- [x] known flags/behavior unchanged; `pnpm run check-types` + lint green (commit 64c4d94, suite 2368 passing)
- [x] a test covers at least the previously-broken three (src/test/cliUsageContract.test.ts)

## Approval log

- 2026-08-18T12:28:36+0200 — APPROVED human_review → complete by USER (batch "approved."). Behaviorally re-verified at approval through the linked binary: `list`, `server status`, `statusline-history project` each exit 64 on an unknown flag. Ships in v2.27.0 (release-via: publish; → published on tag).
- 2026-08-18T12:34:19+0200 — PUBLISHED as agentlenspro@2.27.0 (tag v2.27.0, workflow run 32127117865, OIDC trusted publisher, SLSA provenance verified on registry). Archived as published.
