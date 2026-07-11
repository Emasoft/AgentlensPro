---
trdd-id: 7284WCW7
title: agentlenspro setup — idempotent install/repair verb + single-executable consolidation
column: dev
created: 2026-07-11T04:22:03+0200
updated: 2026-07-11T06:58:00+0200
current-owner: orchestrator-agentlenspro
assignee: setup-command-agent
priority: 1
severity: MEDIUM
effort: L
labels: [cli, installer, dx]
task-type: feature
release-via: publish
delivery: direct-push
target-branch: main
feature-branch: feat/setup-single-executable
merge-strategy: merge
must-pass-tests-before-merge: true
publish-target: npmjs
publish-channel: stable
test-requirements: [unit, integration, lint, typecheck]
review-requirements: []
runtime-targets: [macos, linux]
impacts: [install-script, public-api, config-schema]
implementation-commits: [8b0b0d7, 612ceb9, d4b47b8, cc786ff, 5212fce, 74e31d4, 60dc8e3]
---

# agentlenspro setup — idempotent install/repair + ONE executable

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-11 (impl merged)

- **Current state**: IMPLEMENTED and merged to main (`60dc8e3`, --no-ff; branch
  `feat/setup-single-executable`, 6 commits — see `implementation-commits:`). ONE bin
  (`agentlenspro` → standalone/cli.js, thin shim over `src/cli/main.ts`); subcommands
  setup / server start|stop|restart|status [--supervise] / dashboard / hook / gate /
  heartbeat-cost / telemetry + full diagnostics surface + legacy `--install-*` flags;
  `--version`/`--help` are zero-side-effect (post-publish addendum folded in). 19 absorbed
  script files deleted (grep-verified unreferenced); hook registrations are the command
  strings `agentlenspro hook`/`agentlenspro gate` with auto-migration of v0 (spy-agentlens
  absolute paths) and v1 (PATH-bin) generations. `setup` implements detect → converge →
  verify-per-step (independent re-read paths) → final OTLP→get_recent_sessions round-trip +
  hook/gate exec self-test; corrupt forensics.db → `.corrupt-<ts>` backup-aside; dry-run
  mutates nothing; second run = 0 actions (tested). v2.0.0 + CHANGELOG; README/CLAUDE.md/
  ARCHITECTURE.md/SKILL.md updated.
- **Gates at merge**: tsc (root+media+test) 0, eslint --quiet 0, check-no-mirrors 0,
  esbuild 0, mocha (Node 20) **774 passing / 0 failing / 4 pending** (baseline 753/0/5;
  the 5th pending is an environment-conditional `this.skip()` that RUNS on machines where
  real otel-bodies exist — not a regression).
- **NEXT ACTION**: orchestrator deploys (npm publish v2.0.0 via the publish.yml trusted
  publisher on tag) — column stays `dev` until then.
- **Load-bearing facts**: tests use temp HOME + ephemeral ports ONLY (resident server
  untouched, verified post-suite); all user-config mutations via safeConfigEdit;
  `--install-otel` now delegates to telemetryConfig (the CLI's duplicate OTEL_ENV table had
  drifted); esbuild marks `./server` + `sql.js` external in the cli bundle (cli.js stays a
  ~90KB dispatcher requiring the sibling server.js at runtime).
- **SUPERSEDED — do NOT carry forward**: "five bins / PATH-bin wrapper (P10) contract" —
  replaced by the single-bin command-string contract; the spy-agentlens*.{sh,mjs} scripts
  and their wrappers no longer exist.

## Requirement (USER, 2026-07-11, four messages merged)

1. `agentlenspro setup` — **idempotent**: run all the checks, then install the server,
   recover existing DBs, replace the hooks, the skills, the scripts, the env vars.
2. **Verification step after EVERY converge step** (independent re-read of actual state,
   never trusting the actor's exit code), plus a **final end-to-end test**.
3. **Repair mode**: detect pre-existing installations, older versions, broken or maimed
   installations — missing / wrong / corrupt / truncated env vars, hooks, scripts, skills —
   and repair by overwriting the missing / changed / duplicated things with the correct ones.
4. **ONE and only ONE executable**: remove the other scripts/bins; the single CLI manages
   everything, including the server.

## Design

### Single executable (breaking → v2.0.0)

`package.json` bins collapse to ONE: `agentlenspro` → `standalone/cli.js`. Subcommands:

| Subcommand | Absorbs |
|---|---|
| `agentlenspro setup [--dry-run] [--yes]` | scripts/install.sh, configure-*.sh/ps1, --install-otel/--install-hooks/--install-skill flags |
| `agentlenspro server start\|stop\|restart\|status [--supervise]` | scripts/agentlens-up.sh, scripts/agentlens-supervise.js, --start-server |
| `agentlenspro <diagnostic-tool> ...` + `list` + `help <tool>` | scripts/agentlens-cli.js (all 32 tools, same flags: --param value, --out FILE) |
| `agentlenspro hook` | scripts/agentlenspro-hook.js (stdin lifecycle hook handler) |
| `agentlenspro gate` | scripts/agentlenspro-gate.js (PreToolUse burn-gate) |
| `agentlenspro heartbeat-cost` | scripts/agentlens-heartbeat-cost.js |
| `agentlenspro dashboard` | "open browser" path of agentlens-up.sh |

- Hook REGISTRATIONS become command strings `agentlenspro hook` / `agentlenspro gate`
  (hook commands are shell strings — args allowed). `setup` rewrites old registrations.
- `scripts/safe_config_edit.py` stays as an internal RESOURCE (not a bin) — the CLI invokes
  it; it is not a user-facing executable.
- spy-agentlens*.sh: deleted from the package; `setup` migrates any hook registration still
  pointing at them (any path) to the new command strings.
- The `agentlenspro-diagnostics` skill and all docs updated: `agentlenspro-cli <tool>` →
  `agentlenspro <tool>`.
- Startup dispatch must keep `npx agentlenspro` (no args → server+dashboard, current
  behavior) working.

### `setup` — detect → converge → verify (per step) → final test

Every step is (CHECK → ACT → VERIFY → RECORD). VERIFY re-reads the real state through a
DIFFERENT path than ACT wrote it (falsify-the-layer discipline). Any VERIFY failure →
fail-fast, non-zero exit, no silent fallback. `--dry-run` prints the per-step plan and
changes nothing. `--yes` = non-interactive.

Detection matrix (read-only first pass, printed as a table):
- Install context: registry npm -g / npm link dev tree / npx ephemeral / Homebrew; PATH
  resolution of the bin; duplicate or shadowing older bins (agentlens, agentlens-cli,
  agentlens-dashboard, agentlenspro-cli, -hook, -gate, -heartbeat-cost).
- Data: ~/.agentlens present? schema version vs current, legacy spans.json vs segments,
  sizes, db integrity probe (sqlite quick_check on forensics.db; truncated/corrupt → report,
  back up aside as .corrupt-<ts>, rebuild only what is rebuildable — NEVER silently wipe).
- Server: running pid(s), which build/version they run, port conflicts (3000/4316/4318).
- Hooks in ~/.claude/settings.json: missing, stale-path (old tree, spy-*.sh, removed bins),
  DUPLICATED entries, truncated/corrupt JSON (refuse-unparseable via safeConfigEdit).
- Skill in ~/.claude/skills: missing / outdated / superseded agentlens-diagnostics leftover /
  content drift vs shipped copy (hash compare).
- OTEL env wiring in settings.json: missing keys, wrong endpoint, partial (truncated) blocks.
- Old-generation leftovers: agentlens-dashboard global install/link.

Converge steps (each gated on its check; idempotent second run = all no-ops):
1. DB recover/migrate (boot-time migrations; counts before/after proof — preservation is a
   VERIFY assertion: post-count >= pre-count).
2. Hooks: remove stale/duplicate registrations, install `agentlenspro hook`/`gate` via
   safeConfigEdit; VERIFY by re-parsing settings.json (registration present exactly once,
   no old-path refs remain) + executing the registered command with a synthetic payload.
3. Skill: install/refresh agentlenspro-diagnostics (overwrite on drift); remove superseded
   agentlens-diagnostics only when content matches a known shipped hash; VERIFY by hash.
4. OTEL env: install/repair wiring (verified transaction); VERIFY re-read.
5. Old package removal (npm rm -g agentlens-dashboard when present); VERIFY bins gone.
6. Server: graceful stop old (span-flush wait), start from current install, VERIFY dashboard
   200 + OTLP 200 + pid is new + loaded span count >= pre-stop count.

Final end-to-end test (after all steps): POST a synthetic OTLP span → query it back via the
CLI (`agentlenspro get_recent_sessions` path) → assert round-trip; hook + gate handlers run
against synthetic stdin payloads; unicode-bordered result table (heavy header rule), one row
per step: check state found → action → verify result (PASS/FAIL/SKIP); non-zero exit on any
FAIL. `setup` run twice in tests must produce zero actions on the second run (idempotency is
itself a tested property).

## Acceptance

- ONE bin in package.json; `npm pack --dry-run` list updated accordingly (no orphan script
  files shipped that are no longer reachable).
- Suite grows from 753/0 with real-fs tests (temp HOME, ephemeral ports); zero regressions.
- `setup` on this machine (dev link): all-no-op second run; on a virgin HOME: full install
  path green including final test.
- Docs: README install section, CLAUDE.md, skill — all reference only `agentlenspro`.
- v2.0.0 + CHANGELOG (breaking: bins agentlenspro-cli/-hook/-gate/-heartbeat-cost removed;
  hook registrations auto-migrated by setup).

## Approval log

- 2026-07-11T04:22:03+0200 — USER approved design outline + amendments (verify-per-step,
  final test, repair mode, single executable) in session; Tier 0 in-scope feature.
