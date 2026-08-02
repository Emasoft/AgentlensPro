---
name: agentlenspro-ops-lessons
description: "how to deploy agentlenspro on a machine / setup vs manual install / hooks stopped firing after an upgrade / config file wiped or corrupted after an edit / which file does pnpm read its settings from / minimumReleaseAge or trustPolicy is set but not taking effect / is this supply-chain knob actually live / a guard blocks me editing package.json / is agentlenspro npm-linked or registry-installed / does switching the cli to an ordinary npm install lose my db or settings / where does the data live / can other agents on this machine use the cli / does the dev npm link affect normal published users / background agent shows running but does nothing / a fork started acting like the orchestrator / does agentlenspro run on Windows / setup fails with unsupported platform or node too old / server hangs at 100% cpu and every request times out or SIGTERM is ignored / a settings.json env key keeps reverting or getting overwritten after every server restart / the diagnostics skill shows a stale tool count or drifted from the live CLI surface / how many diagnostic tools are there / keeping the skill and the CLI --help in sync / can I run a second server for testing / two servers at once / I changed the ports so it is isolated right / dev instance wrote to my live data dir / invalid log tail offsets after a restart / I rebuilt and restarted but nothing changed / my fix is not live even though esbuild succeeded / am I testing the repo build or the published one — operational doctrine and field lessons"
ocd: 2026-07-11
lmd: 2026-07-30
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
(accounting); see also [[agentlenspro-publish-pipeline]], [[agentlenspro-identity]] (the
project-identity hub this operational doctrine serves).


^ATOM-B4ON-5F31 [desc:"pnpm 11 reads supply-chain knobs ONLY from pnpm-workspace.yaml — the package.json#pnpm and .npmrc copies are inert, and a guard blocks removing them", keywords: which_file_does_pnpm_read_settings_from minimumReleaseAge_not_taking_effect trustPolicy_ignored package.json_pnpm_block_does_nothing npmrc_supply_chain_knob_inert supply-chain_safeguard_looks_disabled_but_is_not three_files_declare_one_pnpm_setting, ocd: 2026-07-31, lmd: 2026-07-31]

Measured on pnpm 11.9.0 by falsifying each layer in isolated scratch dirs (not inferred from docs):
a dir with ONLY `package.json#pnpm` reports `minimumReleaseAge=undefined` / `trustPolicy=undefined`
— identical to a control dir with no config at all. A dir with ONLY `.npmrc` (`minimum-release-age`
etc.) reports `undefined` too. A dir with ONLY `pnpm-workspace.yaml` reports `7200` /
`no-downgrade`. With `.npmrc: 3000` AND `pnpm-workspace.yaml: 7200` present, pnpm reports **7200** —
the workspace file wins outright and `.npmrc` contributes nothing.

So in this repo the supply-chain knobs are LIVE via `pnpm-workspace.yaml` (minimumReleaseAge 7200,
trustPolicy no-downgrade, blockExoticSubdeps true, plus trustPolicyExclude); the SAME three settings
also sit in `package.json#pnpm` and `.npmrc`, where pnpm 11 ignores them. npm independently proves
those copies dead by warning `Unknown project config "trust-policy"` / `"block-exotic-subdeps"` on
every run. The dead copies were NOT removed: the janitor's `pkg-manager-guard` PreToolUse hook
refuses the edit (`minimumReleaseAge removed (was 7200 ≥ threshold 7200)`), because it models
`package.json#pnpm` as load-bearing. Overriding needs
`CLAUDE_PLUGIN_OPTION_PKG_MANAGER_HOOK_ALLOW_USER_OVERRIDE=true` in Claude Code's own environment.
Context: the refused proposal TRDD-JJFGDV3W, which claimed the safeguard was "disabled". [^17]


^ATOM-DMTT-DOCU [desc:"A segment past ~512 MB throws in readFileSync — it killed setup and silently deleted two days from every query", keywords: Cannot_create_a_string_longer_than_0x1fffffe8 setup_exits_1_on_a_big_store readFileSync_throws_on_a_huge_file span_segment_over_512MB a_whole_day_missing_from_query_results max_string_length, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

A span segment can grow past V8's max string length (~512 MB), and `fs.readFileSync(f,"utf8")` THROWS there — "Cannot create a string longer than 0x1fffffe8 characters". The store caps nothing by design (no eviction; retention deletes whole expired days), so a busy day reaches that size on its own. Measured 2026-08-02: two live segments at 568 MB and 531 MB broke BOTH readers — `agentlenspro setup` exited 1 outright, and `segmentedSpanStore.loadRange` dropped those two whole days from every query inside a `catch { continue }`, with no log line. Every NDJSON walk now goes through `src/ndjsonLines.ts` (chunked reads + a StringDecoder so a UTF-8 sequence split across a chunk boundary is not corrupted), and the store logs a read failure by segment name instead of continuing silently. [^18]


^ATOM-K3U3-GHM5 [desc:"The file-scanning identity check cannot see outbound posts — a second guard covers gh", keywords: check-identities_is_green_but_an_address_is_public agent_pasted_an_account_table_into_an_issue email_leaked_in_a_github_comment redact_a_published_comment guard_scans_files_not_posts, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An identity guard that scans FILES cannot see what an agent POSTS. On 2026-08-02 `check-identities` was green while three of the owner's real email addresses sat in three PUBLIC GitHub issue comments (AgentlensPro#8, ai-maestro#95, ai-maestro#102) — agents had pasted `get_account_status --all` and `lifetime-status.sh` tables, whose every row carries an account's email, straight into a comment. The check was not broken and needed no fix: its scope is tracked and shipped files, and a comment is neither. The second enforcement point is `scripts/deny-identity-leak-to-github.js` (PreToolUse on Bash), which scans any `gh` verb that publishes prose — including the body it would read from `--body-file`, the shape all three leaks actually took — and denies on an email or a real-username home path. Verified by replaying the real leaked body through it: denied, all three addresses named masked. [^19] [^20]


^ATOM-N20K-LDOD [desc:"A bare @handle in GitHub prose pages a real user; backtick it, and use mentions: to find real pages", keywords: at-mention_paged_a_stranger_on_github @manager_@janitor_notified_by_mistake how_to_write_a_handle_without_pinging mentions_search_qualifier_vs_text_search, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An `@name` written in GitHub prose PAGES the account with that handle, and the handles agents reach for are already taken by real people. On 2026-08-02 agents writing role names in issue bodies notified two strangers across 9 issues (confirmed with the authoritative `mentions:<user>` search qualifier — NOT with a text search for the handle, whose 932 hits were GitHub tokenising the word and matching every prose use of it). The fix is one character each side: wrapped in backticks the handle renders as code and notifies nobody. The outbound guard `scripts/deny-identity-leak-to-github.js` now denies a bare mention in any `gh` post, stripping fenced and inline code first so the backticked form still passes.


^ATOM-R4X7-VMJ1 [desc:"DuckDB ignore_errors emits all-NULL rows for bad NDJSON lines - count verifies pass, degradation invisible without count(col)", keywords: duckdb_ignore_errors unparseable_ndjson_line all-NULL_row seal_verify_passes torn_line_silently_lost count_matches_but_data_degraded, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

DuckDB read_json_auto with ignore_errors=true does NOT drop an unparseable NDJSON line — MEASURED (2026-08-02): it lands as an all-NULL row, so a row-count verify passes and cannot detect the degradation. A truncated-after-a-value object is even silently REPAIRED (closed at EOF) and parses fully. Consequence for any seal/convert-verify design: count a required-always column (count(ts) < count(*)) to see NULL-ified torn lines; a count(*) match proves nothing about line integrity. Regression: src/test/statuslineSealAndFilter.test.ts.


^ATOM-POFB-CO8A [desc:"safe-deploy.sh omits check-identities/check-guards - deploy green does not mean CI green; run compile gates before push", keywords: safe-deploy_missing_gate check-identities_not_in_safe-deploy CI_failed_identity_check_but_local_deploy_green push_after_deploy_failed_CI, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

scripts/safe-deploy.sh runs types/lint/tests/esbuild/smoke/restart but NOT check-identities or check-guards — VERIFIED 2026-08-02 (grep 0 hits; a /home/u example path in a comment sailed through safe-deploy green and failed only in CI). Before pushing, run pnpm run check-identities (or full pnpm run compile) even when safe-deploy reports DEPLOYED green.

## Notes and lessons learned

[^1]: [id:ATOM-SETTINGS-WIPE-GUARDRAIL, status:valid, keywords:"config_file_wiped_or_corrupted_after_edit settings.json_wiped safeConfigEdit_guard start_fresh_on_parse_failure_removed", ocd:2026-07-11, lmd:2026-07-11] promoted from the old-repo LOCAL note
  `config-writes-only-via-safe-editor` so the fork's contributors inherit it — the wipe
  incident predates the fork but the guarded code (`src/safeConfigEdit.ts`) is in this
  repo.
[^2]: [id:ATOM-ZOMBIE-FORK-LIVENESS, status:valid, keywords:"background_agent_shows_running_but_does_nothing zombie_fork_stuck_blocking_call liveness_by_transcript_mtime_not_task_alive", ocd:2026-07-11, lmd:2026-07-11] pinger-v4 incident: the fork collapsed a bounded
  230s tick loop into one unbounded kill-file poll; it sat "running" 4h with its
  transcript untouched. The gate's keep-warm allowance and the liveness-by-mtime rule
  come from this.
[^3]: [id:ATOM-FORK-IDENTITY-ANCHOR, status:valid, keywords:"a_fork_started_acting_like_the_orchestrator fork_mistakes_itself_for_orchestrator compaction_or_mid_life_directive identity_anchor_birth_prompt", ocd:2026-07-11, lmd:2026-07-11] promoted from the old-repo LOCAL note
  `fork-mis-resume-as-orchestrator` (a fork inherited a compaction summary and acted as a
  second orchestrator, spawning a duplicate phase agent). The anchor discipline plus the
  gate's fork rules are the guardrails.
[^4]: [id:ATOM-LINK-VS-REGISTRY-DECOUPLED, status:valid, keywords:"does_switching_cli_to_ordinary_npm_install_lose_my_db_or_settings does_dev_npm_link_affect_normal_published_users code_location_vs_data_location_decoupled", ocd:2026-07-11, lmd:2026-07-11] the user (correctly) worried that (a) the machine's CLI
  "being linked to the repo" might make it non-standard/unavailable to other agents and (b)
  switching to a normal install could wipe their DB/settings. Both fears dissolve on the same
  root fact: **code location and data location are fully decoupled.** The link only decides
  which CODE the PATH command runs; the DATA is addressed by `os.homedir()` and the hooks call
  the bare command — so any code copy reads the same `~/.agentlens`, and other agents already
  use the PATH-global CLI. Verified this session by clean-room-installing the packed tarball
  (self-contained, runs with no repo) and by running the CLI from `/tmp`. Lesson: when a
  "how is this installed?" worry surfaces, separate the two questions — *where's the code?* vs
  *where's the state?* — and answer the state question from `os.homedir()`, not the package path.
[^5]: [id:ATOM-DEPLOY-STRICT-TESTS-MANDATORY, status:valid, keywords:"npm_link_dogfood_deploy_strict green_gates_before_bundle_write burn_gate_fail_open_but_bundle_misbehaves deploy_safe_script", ocd:2026-07-11, lmd:2026-07-11] this deploy discipline exists because a dogfood (`npm link`)
  setup makes a build LIVE to many consumers at once, and testing is then non-negotiable. The subtlety
  that makes tests (not just tsc/lint) mandatory: the burn-gate is fail-OPEN, so a bundle that fails to
  load can't hurt anyone (silent no-op) — but a bundle that LOADS and then misbehaves (wrong deny,
  crash mid-hook, bad exit code) DOES reach every session, and only a real test run catches that class.
  Lesson: when a build artifact is live-linked to many consumers, "it compiles" is not "it's safe to
  ship" — the full suite must be green BEFORE the bundle is written, and a red gate means the last
  known-good bundle stays in place, not a rebuild. (A specific machine's CHOICE to run this dogfood
  setup is LOCAL-scope config, not recorded on this shared page.[^6])
[^6]: [id:ATOM-PROJECT-SCOPE-LEAK-CORRECTED, status:valid, keywords:"machine_specific_install_state_moved_to_local project_memory_is_pushed_to_every_cloner would_this_be_true_for_a_stranger_cloning", ocd:2026-07-11, lmd:2026-07-11] this page originally carried this MACHINE's specific install
  state — that its `agentlenspro` was npm-linked at a concrete Homebrew path to a concrete repo path,
  and the owner's decision to dogfood the live build to their running agents. WRONG scope: PROJECT
  memory is git-tracked and pushed, so every future cloner would have inherited one machine's private
  config. Corrected: the git-tracked page keeps only machine-AGNOSTIC facts (the data lives in
  `$HOME`; install method is decoupled from data; the repo ships `deploy:safe`), and the concrete
  per-machine install state moved to a LOCAL-scope note (`~/.claude/projects/<slug>/memory/`,
  never pushed). Lesson: before writing a fact to PROJECT memory, ask "would this be TRUE and USEFUL
  for a stranger cloning the repo on a different machine?" — a path like `/opt/homebrew/...`, a
  hostname, or "on THIS machine / the owner decided…" answers no ⇒ it is LOCAL, not PROJECT.
[^7]: [id:ATOM-DEP-RESOLVE-OWN-NODE-MODULES, status:valid, keywords:"setup_fails_with_unsupported_platform environment_probe_dependency_check require_resolve_paths_override bogus_root_fixture_test_failed", ocd:2026-07-16, lmd:2026-07-16] the probe's dependency check first resolved
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

[^11]: [id:ATOM-RAW-NUL-BINARY, status:valid, keywords:"grep_returns_nothing_on_source_file file_says_data binary_file_matches nul_byte_in_source separator_byte control_byte_in_source verify_reports_missing_but_code_is_there", ocd:2026-07-16, lmd:2026-07-28]
  DO NOT put a raw 0x00 byte in a source file (e.g. as an unambiguous hash-field/join
  separator), BECAUSE file(1) then classifies the whole module as "data" and grep/diff treat
  it as binary — grep -n silently returns NOTHING on a file full of matches (cost a real
  head-scratch on cacheBreakTimeline.ts, 2026-07-16, commit c294238). DO spell it as the backslash-u0000 escape — byte-identical runtime string, text-classified source. Symptom to recall
  this by: "grep finds nothing in a file that obviously contains the pattern."
  RECURRED 2026-07-27 (commit 95d2a1d, burnMonitor.ts:553) **while this lesson already
  existed and already named the remedy** — proof that a recall-by-symptom lesson cannot fire
  at WRITE time, only after you already have the symptom. So the guardrail is now MECHANICAL:
  `scripts_dev/verify-session.sh` § "SOURCE HYGIENE" fails on any sub-0x20 byte (bar TAB/LF/CR)
  in hand-written sources. Swept 2026-07-28 (commit 3608982): four modules were binary —
  burnMonitor, accountStateTimeline, sessionBurnProfile, forensicsIndex. Caveat learned in that
  sweep: **esbuild re-emits a `\x01` source escape as a RAW byte** (it only keeps non-ASCII
  escaped), so `standalone/*.js` is binary no matter how clean the source — never scan the
  bundles, or the check becomes a permanent FAIL people learn to ignore.

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

[^14]: [id:ATOM-PORTS-ARE-NOT-ISOLATION, status:valid, keywords:"second_server_same_data_dir isolated_ports_not_isolated two_servers_one_datadir dev_instance_against_live_data 182_invalid_offsets DATA_DIR_override MCP_PORT_UI_PORT_OTLP_PORT single_instance_guard", ocd:2026-07-28, lmd:2026-07-28]
  DO NOT start a second AgentlensPro server by overriding only `MCP_PORT`/`UI_PORT`/`OTLP_PORT`,
  BECAUSE ports isolate the LISTENERS while both processes keep appending to the SAME span store,
  log-tail offsets and session cards — and the old single-instance guard was gated on
  `OTLP_PORT === 4318`, so changing ports silently opted OUT of the very check that would have
  stopped it (a dev instance ran ~4 min against the live `~/.agentlens`; the next restart found 182
  log-tail offsets invalid where 95 of 107 prior restarts found zero). DO set **`DATA_DIR`** (and
  `HOME`) as well — that is what every test in `src/test/` does and what makes an instance genuinely
  independent. The guard is now keyed on the data dir and refuses a second claimant whatever its
  ports (commit 7d15f6b). Owner directive 2026-07-28: only ONE agentlenspro server may ever run.

[^15]: [id:ATOM-WHICH-BINARY-AM-I-TESTING, status:valid, keywords:"rebuilt_but_nothing_changed fix_verified_but_not_live global_npm_install_vs_npm_link esbuild_then_restart_did_nothing measuring_the_published_bundle which_agentlenspro npx_ran_the_wrong_version npx_pinned_version_ignored post_publish_smoke_test_lies", ocd:2026-07-28, lmd:2026-07-28]
  DO NOT conclude a local change is live after `node esbuild.js` + `agentlenspro server restart`,
  BECAUSE `agentlenspro` may be a REAL global npm install of a PUBLISHED version rather than an
  `npm link` to the repo — in which case the repo bundle is never executed and a whole round of
  "live verification" measures the published code while reporting it as the fix (happened
  2026-07-28: identical 87%/84% numbers before and after, which is what exposed it). DO check what
  the RUNNING pid actually executes — snapshot `ps -eo pid,command`, read the path it names, and
  grep THAT file for a symbol only the new code has — then verify against a repo-built instance with
  its own `DATA_DIR`+`HOME` (see [^14]), or `npm link` first.
  SAME ATOM, SECOND VECTOR (2026-07-28, v2.17.0 publish): **`npx -y agentlenspro@2.17.0 --version`
  printed `2.16.0`, twice** — an explicit `pkg@VERSION` does NOT guarantee npx runs that version
  when a GLOBAL install of the same bin is on PATH; npx prefers the resolvable binary. This silently
  defeats the standard post-publish smoke test (the checklist calls npx "the single strongest smoke
  test" precisely because it is supposed to be cache-free and auth-free). It briefly looked like the
  release had shipped a stale bundle. DO verify a publish by EXTRACTING the tarball and running it by
  path — `npm pack pkg@X && tar -xzf … && node package/<bin> --version` — which resolves nothing and
  cannot be shadowed; the registry-side `_npmUser.trustedPublisher` + `dist.attestations` checks are
  the other half and are equally unshadowable.
[^16]: [id:ATOM-DETECTOR-MATCHED-ITS-OWN-VOCABULARY, status:valid, keywords:"memory-scope-leak flags this page machine-host false positive page about the rule trips the rule detector matched meta-text scope leak proposed", ocd:2026-07-29, lmd:2026-07-29]
  DO NOT go hunting for a leak when `memory-scope-leak` flags THIS page for `machine-host`,
  BECAUSE the only match is the word "hostname" in the scope-routing rule this page QUOTES — a
  page that documents the leak rule necessarily contains the leak rule's vocabulary, so the
  detector matches its own description. DO grep the page for a concrete host/user/path first
  (`<account-nickname>|\.local|MacBook|/Users/<real-name>`) and only act if one is REAL; verified clean
  2026-07-29. Sibling case, already recorded on its own page: the "high-entropy secret" hit on
  [[agentlens-burn-token-model]] is long camelCase identifiers (ATOM-ENTR-IDENT).
[^17]: [id:ATOM-7U4Z-2V6H, status:valid, desc:"resolve a setting the way the tool resolves it, and don't route around a guard that disputes you", keywords:"setting_present_in_config_but_not_taking_effect is_this_knob_actually_live config_declared_in_several_files prove_which_file_the_tool_reads guard_disagrees_with_my_analysis", ocd:2026-07-31, lmd:2026-07-31] DO NOT conclude a setting is live (or dead) from reading the config files, BECAUSE a tool reads only the file IT reads — here three files declared the same knobs and pnpm 11 honoured exactly one, so both "the safeguard is disabled" and "package.json is authoritative" were confidently wrong in opposite directions. DO falsify each layer separately: one scratch dir per source plus a no-config control, and make the sources DISAGREE so the winner is identified rather than merely present. DO NOT route around a safety guard once your test contradicts it, even holding proof, BECAUSE the guard encodes someone else's model of the same risk and being right about the mechanism is not the same as being right about the consequence. DO report the conflict and leave the decision to the human who owns the override.
[^18]: [id:ATOM-6UEY-8Q1C, status:valid, desc:"The failure mode is not the throw — it is the catch that turns the throw into missing data", keywords:"catch_continue_hides_a_read_failure silent_data_loss_at_scale whole_file_read_of_an_uncapped_file why_is_a_day_missing_from_results readFileSync_on_an_append-only_store", ocd:2026-08-02, lmd:2026-08-02] DO NOT read a whole append-only data file with `readFileSync(f,"utf8")`, and NEVER wrap such a read in `catch { continue }`, BECAUSE past ~512 MB the read THROWS V8's max-string-length error and the silent catch then erases that entire file from the answer — the caller sees a smaller result, not an error. DO stream the file (chunked reads + StringDecoder for chunk-split UTF-8) and log any read failure by name: a query that quietly answers with one day less is worse than one that fails.
[^19]: [id:ATOM-OT53-GHOC, status:valid, desc:"A file-scoped check proves nothing about outbound text; verify each hit before redacting", keywords:"green_identity_check_but_public_leak pasting_an_account_table_into_an_issue bulk_redaction_sweep is_this_hit_a_real_address_or_a_placeholder", ocd:2026-08-02, lmd:2026-08-02] DO NOT paste a tool table into a GitHub issue, PR or comment without redacting it first, and DO NOT conclude "no identities are exposed" from a green `check-identities`, BECAUSE that check scans tracked and shipped FILES only — three real addresses sat in public comments while it reported clean, and a published address cannot be unsent. DO route the account/status views through a redaction pass before posting (the PreToolUse guard now refuses the obvious cases), and when sweeping a repo for leaks, VERIFY each hit before editing: one of the four hits found that day was a synthetic `johndoe` example in someone's documentation, and a bulk redaction would have mangled it for nothing.
[^20]: [id:ATOM-RFW9-SKOO, status:valid, desc:"A text search for a handle counts the word, not the ping", keywords:"searching_for_at-mentions_returns_thousands_of_hits same_count_for_different_handles mentions_qualifier", ocd:2026-08-02, lmd:2026-08-02] DO NOT search for who was paged with a text query like `@manager user:Emasoft`, BECAUSE GitHub tokenises away the `@` and matches the WORD — it returned 932 hits, nearly identical counts for four different handles, which is a signal that means nothing. DO use the `mentions:<user>` qualifier, which is recorded from the actual notification and returned the true answer (5 issues each).
