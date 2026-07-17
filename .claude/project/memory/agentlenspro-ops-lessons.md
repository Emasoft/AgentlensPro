---
name: agentlenspro-ops-lessons
description: "how to deploy agentlenspro on a machine / setup vs manual install / hooks stopped firing after an upgrade / config file wiped or corrupted after an edit / is agentlenspro npm-linked or registry-installed / does switching the cli to an ordinary npm install lose my db or settings / where does the data live / can other agents on this machine use the cli / does the dev npm link affect normal published users / background agent shows running but does nothing / a fork started acting like the orchestrator / does agentlenspro run on Windows / setup fails with unsupported platform or node too old / server hangs at 100% cpu and every request times out or SIGTERM is ignored / a settings.json env key keeps reverting or getting overwritten after every server restart / the diagnostics skill shows a stale tool count or drifted from the live CLI surface / how many diagnostic tools are there / keeping the skill and the CLI --help in sync — operational doctrine and field lessons"
ocd: 2026-07-11
lmd: 2026-07-17
metadata:
  node_type: memory
  type: project
  tier: component
---

Operational doctrine (v2.0.0+, single executable):

- **Deploy/install/repair = `agentlenspro setup [--dry-run] [--yes]`** — idempotent
  detect → converge → verify-per-step (independent re-read paths) → final OTLP→MCP
  round-trip self-test. It migrates hook registrations across all generations (v0 absolute
  spy paths, v1 PATH bins, v2 `agentlenspro hook`/`gate` command strings), repairs
  broken/maimed installs (truncated configs, duplicate entries, corrupt sqlite backed
  aside as `.corrupt-<ts>`), and NEVER wipes `~/.agentlens`. Second run must be 0 actions.
- **Setup runs a read-only environment probe FIRST** (stepEnvironment, TRDD-KVDT1XMS,
  cbb484e): pure heuristics before any action — FAIL (blocks setup, exit non-zero) on
  native `win32` ("run inside WSL2" — inside WSL `process.platform === 'linux'`, so WSL is
  never blocked), Node below `engines.node` (read from package.json, never hardcoded), or
  `@duckdb/node-api` unresolvable; WARN-only on `sql.js` missing (OpenCode degrades to
  per-message JSON), a foreign process on the OTLP/UI ports, `~/.claude` absent, or <1 GB
  free disk. Platforms: macOS + Linux; Windows via WSL2 ONLY.[^7]
- **Server control**: `agentlenspro server start|stop|restart|status [--supervise]` —
  restart is graceful (span flush) and the deploy step after any rebuild.
- **Hook changes need a Claude session restart** — running sessions keep the old
  registrations in memory; project-scope settings are re-read only at session start.
- **Every user-config mutation goes through safeConfigEdit** (verified transaction:
  refuse-unparseable, verify-diff, atomic backup+rename, cross-process lock). A direct
  writer with a "start fresh on parse failure" fallback once wiped a user's whole
  settings.json (old-repo commit 1a661a9 removed the pattern — never reintroduce it).[^1]

Background-agent field lessons (they shaped the burn-gate rules):

- **Zombie mode**: a fork can look "running" in the UI while stuck in ONE endless blocking
  shell call — zero API turns, zero effect. Liveness = its transcript file's mtime staying
  fresh, never the task-alive status.[^2]
- **Fork identity anchor**: a fork inherits the parent's full context; after a compaction
  or a mid-life directive it can mistake itself for the orchestrator. Every fork birth
  prompt must carry an identity anchor ("you are X, never orchestrate; if the anchor is
  lost, end") — verified working: an anchored fork correctly refused an orchestration
  directive and handed it to the parent instead of acting.[^3]

Install topology + data model (machine-AGNOSTIC — a specific machine's install state is LOCAL scope,
never this git-tracked page[^6]):

- **DB + settings live in `$HOME`, never in the package/node_modules.** Persistent state is
  `~/.agentlens/` (`forensics.db`, `log-sessions.json`, `log-offsets.json`, `account-state.ndjson`,
  `otel-bodies/`, `spans/`, `*.json` configs), resolved everywhere as
  `path.join(os.homedir(), '.agentlens', …)` — absolute, package-independent. Settings are in
  `~/.claude/settings.json` (hooks + OTEL env); every hook entry calls the BARE command
  (`"agentlenspro hook"`/`"agentlenspro gate"`, PATH-resolved) with absolute `$HOME/.agentlens`
  paths — NONE hardcode a repo path.
- **⇒ How the CLI is installed is DECOUPLED from the data.** The documented dev-CLI setup is
  `npm link` (global `agentlenspro` → the repo build, so local rebuilds are instantly the system-wide
  command); a normal user instead `npm i -g agentlenspro` (a self-contained registry copy — the link
  is local-only, NOT in the tarball, ZERO effect on published users; clean-room proven). Switching
  link ↔ registry install is CODE-ONLY and PRESERVES DB + settings + hooks (the hooks still find
  `agentlenspro` on PATH; the new code reopens the same `~/.agentlens`; `agentlenspro setup` "NEVER
  wipes `~/.agentlens`"). Follow-up: `agentlenspro server restart`. Caveat: a JUST-published version
  can be briefly blocked by the supply-chain min-release-age guard — install the local tarball
  (`npm pack` → `npm i ./agentlenspro-X.tgz`) to sidestep it.[^4]
- **When dogfooding via the `npm link` setup, deploy STRICT: green gates BEFORE any bundle write.**
  A linked bundle is live for EVERY Claude Code instance on that machine (the CLI powers each agent's
  hooks + the burn-gate PreToolUse deny), so a broken build has machine-wide blast radius. The repo
  ships **`pnpm run deploy:safe`** (`scripts/safe-deploy.sh`) for exactly this: full gate suite in
  order (check-types → lint → check-no-mirrors → compile-tests → the whole Mocha suite under Node 20,
  baseline 849/0), aborts before any bundle write on the first red (last known-good stays live),
  smoke-checks the built CLI (`cli --version` == package version) before restarting, and has its own
  stubbed-gate test (`src/test/safeDeploy.test.ts`). `--dry-run` = gates only; `--no-restart` = build
  but don't restart. Prefer it over bare `node esbuild.js` for any linked deploy. WHY tests are a
  MANDATORY gate (not just tsc/lint): the burn-gate is fail-OPEN, so a bundle that fails to LOAD hurts
  nobody — the dangerous class is a bundle that loads and MISBEHAVES, which only a real test run
  catches.[^5]

Governed by [[cache-ttl-model]] (TTL regimes) and [[agentlens-burn-token-model]]
(accounting); see also [[agentlenspro-publish-pipeline]].

## Notes and lessons learned

[^1]: [ocd:2026-07-11 lmd:2026-07-11] promoted from the old-repo LOCAL note
  `config-writes-only-via-safe-editor` so the fork's contributors inherit it — the wipe
  incident predates the fork but the guarded code (`src/safeConfigEdit.ts`) is in this
  repo.
[^2]: [ocd:2026-07-11 lmd:2026-07-11] pinger-v4 incident: the fork collapsed a bounded
  230s tick loop into one unbounded kill-file poll; it sat "running" 4h with its
  transcript untouched. The gate's keep-warm allowance and the liveness-by-mtime rule
  come from this.
[^3]: [ocd:2026-07-11 lmd:2026-07-11] promoted from the old-repo LOCAL note
  `fork-mis-resume-as-orchestrator` (a fork inherited a compaction summary and acted as a
  second orchestrator, spawning a duplicate phase agent). The anchor discipline plus the
  gate's fork rules are the guardrails.
[^4]: [ocd:2026-07-11 lmd:2026-07-11] the user (correctly) worried that (a) the machine's CLI
  "being linked to the repo" might make it non-standard/unavailable to other agents and (b)
  switching to a normal install could wipe their DB/settings. Both fears dissolve on the same
  root fact: **code location and data location are fully decoupled.** The link only decides
  which CODE the PATH command runs; the DATA is addressed by `os.homedir()` and the hooks call
  the bare command — so any code copy reads the same `~/.agentlens`, and other agents already
  use the PATH-global CLI. Verified this session by clean-room-installing the packed tarball
  (self-contained, runs with no repo) and by running the CLI from `/tmp`. Lesson: when a
  "how is this installed?" worry surfaces, separate the two questions — *where's the code?* vs
  *where's the state?* — and answer the state question from `os.homedir()`, not the package path.
[^5]: [ocd:2026-07-11 lmd:2026-07-11] this deploy discipline exists because a dogfood (`npm link`)
  setup makes a build LIVE to many consumers at once, and testing is then non-negotiable. The subtlety
  that makes tests (not just tsc/lint) mandatory: the burn-gate is fail-OPEN, so a bundle that fails to
  load can't hurt anyone (silent no-op) — but a bundle that LOADS and then misbehaves (wrong deny,
  crash mid-hook, bad exit code) DOES reach every session, and only a real test run catches that class.
  Lesson: when a build artifact is live-linked to many consumers, "it compiles" is not "it's safe to
  ship" — the full suite must be green BEFORE the bundle is written, and a red gate means the last
  known-good bundle stays in place, not a rebuild. (A specific machine's CHOICE to run this dogfood
  setup is LOCAL-scope config, not recorded on this shared page.[^6])
[^6]: [ocd:2026-07-11 lmd:2026-07-11] this page originally carried this MACHINE's specific install
  state — that its `agentlenspro` was npm-linked at a concrete Homebrew path to a concrete repo path,
  and the owner's decision to dogfood the live build to their running agents. WRONG scope: PROJECT
  memory is git-tracked and pushed, so every future cloner would have inherited one machine's private
  config. Corrected: the git-tracked page keeps only machine-AGNOSTIC facts (the data lives in
  `$HOME`; install method is decoupled from data; the repo ships `deploy:safe`), and the concrete
  per-machine install state moved to a LOCAL-scope note (`~/.claude/projects/<slug>/memory/`,
  never pushed). Lesson: before writing a fact to PROJECT memory, ask "would this be TRUE and USEFUL
  for a stranger cloning the repo on a different machine?" — a path like `/opt/homebrew/...`, a
  hostname, or "on THIS machine / the owner decided…" answers no ⇒ it is LOCAL, not PROJECT.
[^7]: [ocd:2026-07-16 lmd:2026-07-16] the probe's dependency check first resolved
  `@duckdb/node-api`/`sql.js` with `require.resolve(dep, { paths: [repoRoot] })` — WRONG,
  BECAUSE the deps that matter at runtime are the INSTALLED PACKAGE'S OWN (the CLI resolves
  them from its own node_modules), and pinning resolution to an injectable repoRoot made the
  bogus-root fixture test fail the environment step before the step under test. DO use plain
  `require.resolve(dep)` for "can the running code load its runtime deps"; reserve
  `paths:` overrides for probing a DIFFERENT tree than the one executing.

[^8]: [id:ATOM-WEDGE-BOUND, status:valid, keywords:"server_hang 100%_cpu every_request_hangs event_loop_starved SIGTERM_ignored unbounded_scan flatMap_reparse", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT let any request handler run unbounded synchronous O(corpus) work on the event loop
  (the wedge class: `scanPool.flatMap(asTimeline)` = 50 back-to-back multi-MB transcript
  reparses → 100% CPU, EVERY request hangs, SIGTERM ignored, SIGKILL required — recurred twice,
  2026-07-13/16), BECAUSE a bare `await` of a resolved promise drains only MICROTASKS — queued
  HTTP requests are macrotasks and never interleave. DO use `scanWithBudget` (src/mcpServer.ts:
  setImmediate yield per item + deadline + honest stoppedEarly coverage) for every corpus-fanning
  drill; the loopWatchdog (SharedArrayBuffer beat + worker SIGKILL/respawn) is the backstop, and
  the per-tool start/done log lines in server.log name a wedger (last start with no done).

[^9]: [id:ATOM-ONE-RESOLVER, status:valid, keywords:"settings_key_overwritten_on_boot two_writers_converge different_value spool_repointed_ssd OTEL_LOG_RAW_API_BODIES", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT let two code paths independently COMPUTE the value of a force-converged config key
  (the CLI wired OTEL_LOG_RAW_API_BODIES at the RAM-disk spool; the spool-BLIND server-boot
  converge re-pointed it at the legacy SSD dir minutes later — last writer wins, silently),
  BECAUSE converge-on-boot means the boot's answer always eventually wins, so any writer
  disagreement becomes permanent drift toward the boot's value. DO route every writer through
  the ONE resolver (`effectiveBodiesDir` in src/captureConfig.ts, commit 4efe0f5); when adding
  a converged key, ask "who else computes this value?" before shipping.

[^10]: [id:ATOM-THREE-SQL-ENGINES, status:valid, keywords:"add_preset_wrong_engine pragma_rejected duckdb_preset_in_diagnostics_sql which_sql_engine no_wal_no_database_file", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT add DuckDB-flavored SQL (pragma_database_size, SUMMARIZE, parquet_metadata, a .wal
  check) to `run_diagnostics_sql` presets, BECAUSE that tool runs on the sql.js/SQLite
  forensics SNAPSHOT (src/forensicsSql.ts → forensicsDb.ts; its gate rejects PRAGMA outright)
  — and the DuckDB store is FILELESS (`:memory:` catalog rebuilt from Parquet parts at every
  open: no db file, no WAL, no catalog file to back up). DO route by engine: transcripts →
  `run_transcript_sql` (src/transcriptSql.ts, DuckDB over .jsonl), fact-DB analytics →
  `run_diagnostics_sql` (SQLite), store tuning → the connection SETs in src/store/db.ts.
  (The 2026-07-16 corpus-mining shortlist got items 2+4 wrong on exactly this — TRDD-802FP7ZL.)

[^11]: [id:ATOM-RAW-NUL-BINARY, status:valid, keywords:"grep_returns_nothing_on_source_file file_says_data binary_file_matches nul_byte_in_source separator_byte", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT put a raw 0x00 byte in a source file (e.g. as an unambiguous hash-field/join
  separator), BECAUSE file(1) then classifies the whole module as "data" and grep/diff treat
  it as binary — grep -n silently returns NOTHING on a file full of matches (cost a real
  head-scratch on cacheBreakTimeline.ts, 2026-07-16, commit c294238). DO spell it as the backslash-u0000 escape — byte-identical runtime string, text-classified source. Symptom to recall
  this by: "grep finds nothing in a file that obviously contains the pattern."

[^12]: [id:ATOM-NO-USERNAME-ASSUMPTION, status:valid, keywords:"hardcoded_username shipped_path_assumes_home /Users/USER launchd_plist_template portable_install any_machine dev_machine_path_in_repo", ocd:2026-07-17, lmd:2026-07-17]
  DO NOT let any SHIPPED surface (tarball file, doc, contract, template) assume the
  installer's username or home layout — e.g. the `@USER@`-substituted `/Users/…` log paths
  in the old scripts/agentlens.plist.template, BECAUSE anyone installs AgentlensPro/ai-maestro
  on any machine (owner directive 2026-07-17); a `/Users/<name>`-shaped path breaks
  custom/network homes and non-macOS. DO derive paths at runtime (`os.homedir()`, `DATA_DIR` env) — the embedded
  plist in serverControl.ts (`@HOME@` substitution) is the one source of truth; the stale
  template duplicate was removed for exactly the two-versions-drift this rule predicts.
  Repo hygiene corollary: test fixtures use synthetic homes (`/Users/x`), never the dev
  machine's real username.

[^13]: [id:ATOM-SKILL-CLI-DISCOVERY-SYNC, status:valid, keywords:"diagnostics_skill_stale tool_count_hardcoded how_many_diagnostic_tools skill_drifted_from_cli list_--desc discovery_surfaces keep_skill_and_help_in_sync", ocd:2026-07-17, lmd:2026-07-17]
  DO NOT hardcode a diagnostic-tool COUNT (the skill said "all 37 tools"; the live surface was 46
  on 2026-07-17) or an exhaustive tool/flag/matcher list in the two discovery surfaces — the
  `agentlenspro-diagnostics` SKILL.md and the CLI `USAGE` in src/cli/diagnosticsCli.ts — BECAUSE
  the tool set grows and any baked-in number/list silently goes stale (the burn-gate prose matcher
  had also drifted to `^(Task|Agent|Workflow)$`, missing `SendMessage`). DO write "run `list --desc`
  for the live set" and, whenever the skill is touched, re-verify every concrete flag/bucket/matcher
  against the LIVE schema (`agentlenspro help <tool>`, `list | grep -c .`, the authoritative
  `GATE_MATCHER` in src/cli/hookInstall.ts) — never against memory. Both surfaces ship in the npm
  tarball (the skill via `--install-skill`, the help bundled into standalone/cli.js), so a stale one
  reaches every user. (TRDD-HNNRGXJH, commit e7599db.)
