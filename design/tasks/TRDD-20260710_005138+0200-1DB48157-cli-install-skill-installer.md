---
trdd-id: 1DB48157
title: CLI --install-skill + one-command automated installer
column: dev
created: 2026-07-10T00:51:38+0200
updated: 2026-07-10T00:51:38+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 2
effort: S
labels: [cli, install, skill]
test-requirements: [lint, typecheck]
relevant-rules: []
---

# CLI --install-skill + one-command automated installer

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-10

**Current state:**
- DONE: canonical skill copy committed INTO the repo at `skills/agentlens-diagnostics/SKILL.md`
  (moved from user scope so the CLI can install it; already includes the `--install-skill` row).
- PENDING: `--install-skill` flag in `scripts/agentlens-cli.js`.
- PENDING: `scripts/install.sh` (does not exist yet — `ls scripts/` confirmed; `agentlens-up.sh`
  is the launcher, NOT the installer).
- PENDING: gates (lint) + local commit (NEVER push; stage by name).

**NEXT ACTION:** implement `--install-skill` in `scripts/agentlens-cli.js`:
read `path.resolve(__dirname, '..', 'skills', 'agentlens-diagnostics', 'SKILL.md')`, compare
with `~/.claude/skills/agentlens-diagnostics/SKILL.md`, `mkdir -p` + write when missing or
different, print one of `installed` / `updated` / `already current`. Idempotent by content
comparison. Then write `scripts/install.sh` per the requirements below.

**Load-bearing facts:**
- The CLI is globally linked via `npm link` (pnpm's global bin dir is NOT on PATH — use npm).
- `__dirname` resolves through the global symlink to the real repo `scripts/` dir (node
  realpaths the main module), so repo-relative paths work from anywhere.
- Unit tests run under node@22 (`/opt/homebrew/opt/node@22/bin/node node_modules/mocha/bin/mocha.js`);
  node 26 breaks mocha's yargs.

**Requirements (user's words, 2026-07-10):**
1. `--install-skill`: reinstall the skill if missing from `~/.claude/skills/` — idempotent.
2. Rewrite the install script to be easy to use and completely automated
   (`scripts/install.sh`, new): deps → build → `npm link` → `agentlens-cli --install-skill`
   → `agentlens-cli --start-server`. Fail-fast (`set -euo pipefail`), node ≥18 check,
   pnpm with npm fallback.
3. The installer must NOT install the OTEL settings — but at the END it must print that for
   better data it is RECOMMENDED to run `agentlens-cli --install-otel`.

**SUPERSEDED — do NOT carry forward:** the skill being user-scope-only (it now lives in-repo;
the user-scope copy at `~/.claude/skills/` is a managed installation target, not the source).

## Context

The diagnostics skill was moved to user scope (`~/.claude/skills/agentlens-diagnostics/`) so it
works from any project, but nothing recreates it if deleted, and fresh machines need a
one-command setup. The CLI already carries the ops surface (`--status`, `--start-server`,
`--install-otel`, …) — skill installation belongs on the same surface, with the repo copy as
the single source of truth.

## Verification

- `agentlens-cli --install-skill` twice: first run `installed` (or `updated`), second run
  `already current`; file byte-identical to the repo copy.
- Delete `~/.claude/skills/agentlens-diagnostics/` → run again → reinstalled.
- `bash scripts/install.sh` on the repo completes end-to-end, prints the `--install-otel`
  recommendation, does NOT touch `~/.claude/settings.json`.
- `pnpm run lint` 0 errors; commit local-only, staged by name.
