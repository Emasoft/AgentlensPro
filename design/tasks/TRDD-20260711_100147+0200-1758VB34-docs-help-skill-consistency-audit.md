---
trdd-id: 1758VB34
title: Docs/help/skill consistency audit — verify every doc claim against shipped code
column: backburner
created: 2026-07-11T10:01:47+0200
updated: 2026-07-11T10:01:47+0200
current-owner: orchestrator-agentlenspro
priority: 3
severity: LOW
effort: S
labels: [docs, correctness]
task-type: docs
release-via: publish
blocked-by: [VY1IUVUM]
implementation-commits: []
---

# Docs/help/skill consistency audit

## Requirement (USER 2026-07-11)

After the TTL work (VY1IUVUM) merges, update the documentation, the CLI `--help` output, and
the skill so EVERYTHING reflects the current shipped code (v2.0.0 single executable + setup,
v2.1.0 get_agent_tokens, v2.2.0 TTL-regime detection + account command). Verify every doc
claim against the actual code — a name is a hypothesis; confirm before asserting.

## Known hit list (found 2026-07-11, verify each is still true when this runs)

- `ARCHITECTURE.md` ~L894 + L988: the keepWarm section states "cache TTL is ~5 minutes
  (`CACHE_TTL_MS`)" — becomes WRONG once VY1IUVUM ships the TTL-regime model. Rewrite to the
  matrix (subscription main = 1h, subagent = 5m, etc.) and the resolved-regime source. (Do
  NOT rewrite before VY1IUVUM merges — until then the 5-min text matches shipped behavior.)
- `skills/agentlenspro-diagnostics/SKILL.md` ~L139: `COLD_RESUME_RISK` row says "the stall
  outlived the 5-min cache TTL" — make regime-aware.
- CLI `--help`: confirm every subcommand (setup / server / dashboard / hook / gate /
  heartbeat-cost / the diagnostics surface) is listed, and that `get_agent_tokens` +
  `get_account_status`'s new fields appear where help enumerates tools.
- `README.md` / `CONTRIBUTING.md`: `pnpm run local` VERIFIED to still exist (2026-07-11 —
  do NOT "fix" it as stale). Re-check other command references against package.json scripts.

## Build-hygiene smell to decide (found during the pre-switch audit)

`node esbuild.js` OVERWRITES the git-tracked `media/dashboard.css` with its minified build
output — so every build dirties the tree and there are effectively two owners for that file.
Decide ONE owner: either gitignore it + always-build, or keep it tracked + never rebuilt in
place. (The 1.0.0 tarball shipped the built form and works, so no user-facing bug — this is
a repo-hygiene cleanup.)

## Acceptance

- Every doc/help/skill claim about commands, tools, and the TTL model matches the code.
- The build-hygiene decision is made and applied (one owner for media/dashboard.css).
- Gates green; no code behavior change (docs-only + the css-ownership fix).
