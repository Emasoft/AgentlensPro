---
trdd-id: HNNRGXJH
title: Refresh the diagnostics skill to the live CLI surface and add an examples section to the CLI help
column: complete
created: 2026-07-17T19:08:30+0200
updated: 2026-07-17T19:14:00+0200
current-owner: main
task-type: docs
relevant-rules: []
implementation-commits: [e7599db]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-17 19:14 — DONE + LOCALLY DEPLOYED

DONE (commit e7599db). Both artifacts refreshed + verified; ships in the next npm release (the
skill is in the tarball, the CLI help is in `standalone/cli.js`). If a release cuts this,
move column complete→published like F1VX3M7C.

### Shipped
- CLI help: `examples:` section added to `USAGE` (`src/cli/diagnosticsCli.ts`) — 15 worked recipes.
- Skill (`skills/agentlenspro-diagnostics/SKILL.md`): (a) de-numbered "37" → "run `list --desc`
  for the live set"; (b) matcher prose `^(Task|Agent|Workflow)$` → `…|SendMessage)$`; (c) new
  "Server, daemon & telemetry control" section; (d) new "Context-composition & session-drill
  tools" table (19 previously-undocumented tools; every flag verified against the live schema —
  get_cache_creation_report bucket list corrected to cache_creation|output|input|total|billable_weighted).
- Gate: tsc ×2 = 0, lint 0-err, check-mirrors OK (113 exports), mocha 1381 passing / 8 pending / 0
  failing. esbuild rebuilt; `standalone/cli.js` carries the new help marker; `agentlenspro
  --install-skill` synced installed==repo; `agentlenspro --help` renders the examples; `list`
  count = 46.
- No server restart: CLI-only change (server bundle byte-identical; `--help` is pre-network).

### NEXT ACTION
None. Ships with the next release (user-gated, like the other unpushed local-main commits).

--- original plan (below) preserved ---

## ⏵ (superseded plan) — 2026-07-17 19:08

User directive (verbatim): "update the skill with the latest cli commands, and also extend the
cli help with more examples and use cases."

Two artifacts, both SHIPPED in the npm tarball:
- `skills/agentlenspro-diagnostics/SKILL.md` (repo = packaged copy; `--install-skill` installs it).
- `USAGE` in `src/cli/diagnosticsCli.ts` → the `agentlenspro --help` output (bundled into
  `standalone/cli.js`). Per-tool `help <tool>` is schema-driven (`renderHelp`) and needs no edit.

Verified staleness (live surface read 2026-07-17):
1. Tool count: **46** (`agentlenspro list | grep -c .`), skill says "Covers all 37 diagnostic
   tools" (line 12). FIX = drop the hardcoded number (it re-goes-stale) → "the full suite; run
   `list --desc`".
2. Burn-gate matcher: authoritative `GATE_MATCHER = '^(Task|Agent|Workflow|SendMessage)$'`
   (`src/cli/hookInstall.ts:35`); skill line 254 says `^(Task|Agent|Workflow)$` — missing
   `SendMessage`. (Line 70's table entry already had it — only the prose was stale.)
3. `daemon` verb family (`daemon start|stop|restart|status`, `daemon install|uninstall` launchd),
   `telemetry install|uninstall|status`, and `heartbeat-cost [--oneline]` subcommands: undocumented
   in the skill body (only the `--install-otel/--uninstall-otel` flags are).

### Plan (single focused pass — 2 files + rebuild + reinstall)
- P1 CLI help: add an `examples:` section to `USAGE` (concrete recipes: investigate_burn, --guard,
  get_agent_tokens, get_cost_rollup, predict_session_cost, check_cache_expiry, batch, --out,
  env, setup, dashboard). Static help path — no server change.
- P2 skill: (a) de-number the tool count; (b) fix the matcher prose; (c) add a "Server & daemon
  control" subsection (server/daemon/telemetry/heartbeat-cost verbs); (d) add the missing
  high-value tool rows (context-composition/drill family + get_session_status / get_cost_by_cause
  / get_subagent_tree / get_image_report) while keeping the "discover via `list --desc`" ethos.
- P3 gate + deploy: `pnpm run check-types` (×2) + `pnpm run lint` + `pnpm run check-mirrors` +
  mocha; `node esbuild.js` succeeds; grep the rebuilt `standalone/cli.js` for the new `examples:`
  marker; `agentlenspro --install-skill` to sync the installed copy; `agentlenspro --help` shows
  the examples. Server restart NOT required (USAGE is a pre-network static string) but harmless.

### NEXT ACTION
Edit `USAGE` (examples section) + `SKILL.md` (4 fixes), then gate + rebuild + `--install-skill`.

### Verify
`agentlenspro --help` prints the examples section; `agentlenspro list \| grep -c .` == the number
the skill no longer hardcodes; installed skill == repo skill (`diff`).

## Context

The diagnostics skill and the CLI `--help` are the two discovery surfaces a fresh agent hits. The
skill is curated (it relies on `list --desc` for the full set by design), but it had drifted: a
hardcoded tool count, one stale burn-gate matcher in prose, and three top-level verbs added since
the skill was last touched. The CLI help had a full command/flag reference but no worked examples.

## Notes and lessons learned
