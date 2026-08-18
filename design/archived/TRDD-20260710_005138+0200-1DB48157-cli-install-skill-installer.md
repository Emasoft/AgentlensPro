---
trdd-id: 1DB48157
title: CLI --install-skill + one-command automated installer
column: completed
created: 2026-07-10T00:51:38+0200
updated: 2026-08-18T12:45:00+0200
implementation-commits: [d4c7188, a4235f3]
last-test-result: pass
last-test-at: 2026-07-10T01:14:00+0200
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

**COMPLETE — all shipped and verified 2026-07-10 (commits d4c7188 + a4235f3, local-only).**

- DONE: canonical skill copy in-repo at `skills/agentlens-diagnostics/SKILL.md` (d4c7188).
- DONE: `--install-skill` in `scripts/agentlens-cli.js` (a4235f3) — verified all three paths
  live: `updated` (stale user copy), `already current` (rerun), `installed` (after deleting
  the user-scope dir); result byte-identical to the repo copy each time.
- DONE: `scripts/install.sh` (a4235f3) — ran end-to-end on this repo: node check → pnpm
  frozen-lockfile → esbuild → npm link → `already current` → server RUNNING + status → ends
  with the `--install-otel` recommendation. `grep -c OTEL ~/.claude/settings.json` = 18
  before AND after (settings untouched). Deviation from the original sketch: npm fallback is
  `npm install`, not `npm ci` — the repo has no package-lock.json, so `npm ci` would fail by
  construction.
- DONE: `pnpm run lint` 0 errors (65 pre-existing no-console warnings, normal for a CLI).

**NEXT ACTION:** none — task complete.

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

## Approval log
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: installSkill() at src/cli/hookInstall.ts:628 still implements the idempotent installed/updated/current behavior (skill renamed agentlens-diagnostics -> agentlenspro-diagnostics, same architecture).
