---
trdd-id: 1758VB34
title: Docs/help/skill consistency audit — verify every doc claim against shipped code
column: complete
created: 2026-07-11T10:01:47+0200
updated: 2026-07-11T10:58:09+0200
current-owner: orchestrator-agentlenspro
priority: 3
severity: LOW
effort: S
labels: [docs, correctness]
task-type: docs
release-via: publish
blocked-by: []
implementation-commits: [a1a9e59]
---

# Docs/help/skill consistency audit

## ⏵ STATE — READ THIS FIRST ON RESUME — 2026-07-11 (COMPLETE — awaiting tag → published)

Done on `docs/ttl-consistency-audit`, releasing as v2.3.1. Findings + resolutions (each verified
against code, not assumed):

- **`CACHE_TTL_MS` is GONE** (grep-proven — removed by VY1IUVUM). Fixed `ARCHITECTURE.md` L894 (the
  "~5 minutes (`CACHE_TTL_MS`)" claim → the per-session `TtlRegime` / `computeKeepWarm(timeline, regime)`
  model) and L988 (the file-tree descriptor; added a `cacheTtl.ts` line).
- **`SKILL.md` `COLD_RESUME_RISK` row** → regime-aware (subagents ALWAYS ride 5-min even when the main
  session is 1-hour). The other "5-min" refs in ARCHITECTURE/SKILL are the SPAN window / BURN window /
  cold-resume-fanout window — CORRECT, left as-is (verified, not blindly changed).
- **CLI --help / tool list** is auto-generated from the live MCP schema, so `get_agent_tokens` /
  `get_account_status` (new fields) / `get_account_state_at` appear automatically — no manual help edit.
- **Doc command refs verified present**: `pnpm run local`/`capture`/`demo`/`check-types`/`lint`/
  `test:unit` all exist in package.json. `pnpm run local` was NOT stale (as the hit list warned).
- **`media/dashboard.css` build-ownership DECISION = gitignore it** (Option A). Evidence: it is an
  esbuild output (bundled from `media/src/styles/*.css` via the dashboard entry's CSS imports), yet was
  the ONLY tracked build artifact — every sibling (`media/dashboard.js`, `standalone/*.js`,
  `media/sidebar.js`, even its own `.css.map`) is already gitignored. Applied `git rm --cached` +
  `.gitignore` entry; the single owner is now `media/src/styles/*.css`. SAFE: publish.yml runs
  `node esbuild.js --production` BEFORE `npm pack`, and `npm pack --dry-run` confirmed the 31.5kB
  `media/dashboard.css` still ships (it stays in the `files` allowlist; pack reads on-disk, not git).

- **SUPERSEDED — do NOT carry forward**: the hit list's premise that this needed VY1IUVUM to merge
  first (it has — v2.2.0) and the "esbuild overwrites dashboard.css → decide" open question (decided).

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
