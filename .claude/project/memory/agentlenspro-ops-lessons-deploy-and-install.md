---
name: agentlenspro-ops-lessons-deploy-and-install
description: "how to deploy agentlenspro on a machine / setup vs manual install / hooks stopped firing after an upgrade / config file wiped or corrupted after an edit / which file does pnpm read its settings from / minimumReleaseAge or trustPolicy is set but not taking effect / is this supply-chain knob actually live / a guard blocks me editing package.json / is agentlenspro npm-linked or registry-installed / does switching the cli to an ordinary npm install lose my db or settings / where does the data live / can other agents on this machine use the cli / does the dev npm link affect normal published users / does agentlenspro run on Windows / setup fails with unsupported platform or node too old / a settings.json env key keeps reverting / can I run a second server for testing / two servers at once / I changed the ports so it is isolated right / dev instance wrote to my live data dir / invalid log tail offsets after a restart / I rebuilt and restarted but nothing changed / my fix is not live even though esbuild succeeded / am I testing the repo build or the published one / a server exited silently after deploying a new binary / the exec gate said the binary still does not exec but it was only a usage error / exit 64 after a deploy is not a kill, only exit 137 means the kernel killed it / codesign says valid on disk but every exec is still killed / the same cp-over-binary trap hit twice because the deploy page was not recalled first / how many diagnostic tools are there / keeping the skill and the CLI --help in sync / the CLI --help flag ran the command instead of showing help / a baseline ruleset restore reverted the owner's force-push bypass"
ocd: 2026-07-11
lmd: 2026-09-02
metadata:
  node_type: memory
  type: project
  tier: aspect
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
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
Context: the refused proposal TRDD-JJFGDV3W, which claimed the safeguard was "disabled". [^17] [^23]




^ATOM-9B2N-KU2R [desc:"CLI help is TOTAL since 2.23.0: --help/-h anywhere in argv routes to help and dispatches NOTHING — before that, disable --help EXECUTED the disable", keywords: help_flag_executed_the_command disable_--help_disarmed_everything --help_ran_the_verb help_must_dispatch_nothing MANAGEMENT_VERBS help-total_contract, type: project, ocd: 2026-08-05, lmd: 2026-08-05]

Since v2.23.0 the CLI help contract is TOTAL (git/npm style): `--help`/`-h` ANYWHERE in argv routes to help and dispatches NOTHING — enforced by an intercept in `cliMain` (src/cli/main.ts) BEFORE the dispatch switch, with a `MANAGEMENT_VERBS` set gating network-free help for management verbs. WHY it must be this way: on 2026-08-05 `agentlenspro disable --help` EXECUTED the disable — it armed the DISABLED flag, stopped the server, and disarmed every hook machine-wide, because the old dispatcher matched the verb first and passed `--help` through as an ordinary arg. Any new verb added to the CLI inherits the intercept automatically; never add a verb-local `--help` handler that runs after side effects. Falsified tests: src/test/cliDispatch.test.ts ("help is TOTAL", 4 tests that failed 0/4 against the pre-fix bundle).




^ATOM-IALX-LKC6 [desc:"Exit 1 is the watchers' ABORT signal, so a caller mistake must exit 64 via UsageError; and 'help <verb>' must answer from static USAGE for every management verb", keywords: cli_returned_exit_1_for_a_typo why_did_my_batch_abort_on_a_bad_flag exit_code_64_EX_USAGE_convention agentlenspro_help_verb_says_unknown_tool agentlenspro_list_does_not_show_cli_verbs server_expects_start_stop_restart_status_exit_code, type: project, ocd: 2026-08-12, lmd: 2026-08-12]

**Exit 1 is NOT the generic failure code — it is the watchers' ABORT signal** (`src/cli/cliErrors.ts`
reserves it, and `budget --watch` uses it to mean "stop the run"). So a caller mistake must exit
**64** (`EX_USAGE`) or a typo becomes indistinguishable from a legitimate abort: the batch stops,
and the operator goes hunting for a burn that never happened. `standalone/cli.ts` maps the ERROR
TYPE, not the site — `e instanceof UsageError ? EXIT.USAGE : 1` — so the fix for a verb with the
wrong code is to throw `UsageError`, never to hardcode 64 at the throw site (that would drift the
moment the mapping moves).

Found by RUNNING every verb, not by review: `agentlenspro server` (subcommand omitted) exited 1
while `budget`, `watch` and `ctxmap` all exited 64 for the identical missing-argument shape. Each
site reads fine alone; only the matrix makes the inconsistency visible.

**`help <verb>` must answer for every management verb, from static USAGE, touching no socket** —
the same doctrine as ATOM-9B2N-KU2R's "help is TOTAL" (recall it by id, not a wikilink — a `[[…]]`
target is a page `name:`, and an atom id is not one). It did not: every management verb fell
through to the diagnostics path, which resolves names against the SERVER'S live tool schema, and
failed with `unknown tool "budget" (agentlenspro list)`. The remedy that message named leads
nowhere — `list` enumerates diagnostics tools only, never CLI verbs — so the user was sent to the
one command that cannot answer them. An UNRECOGNISED name must still fall through and fail loudly:
answering a typo with usage and exit 0 would be worse than the dead-end, because nothing would tell
the user the name was wrong.




^ATOM-57QU-GOU1 [desc:"force-push or history rewrite blocked on main / baseline restore reverted the admin bypass / who may bypass baseline-history-protect on AgentlensPro — owner-ordered deviation, do not restore", keywords: force_push_blocked_on_main cannot_rewrite_history_main non_fast_forward_denied baseline_restore_reverted_bypass history_protect_bypass_owner ruleset_drift_false_positive, ocd: 2026-08-13, lmd: 2026-08-13]

OWNER RULING (2026-08-13, verbatim: 'both the baseline-history-protect and the baseline-pr-and-check must be changed to allows mutations in history and direct pushing/merging by the owner'): on the AgentlensPro repo, baseline-history-protect carries a DELIBERATE deviation from the ratified pair — bypass_actors [{actor_id:5, RepositoryRole, always}] so the owner/admin may force-push and delete on main. Applied 2026-08-13T16:08:34+02:00 via PUT rulesets/18778596; verified current_user_can_bypass=always. baseline-pr-and-checks already carried the identical admin bypass (ratified shape) — no change was needed there. Any baseline-restore/drift pass MUST NOT strip this bypass back to the ratified empty list on this repo — that would revert a Tier-3 owner decision as if it were drift.




^ATOM-POFB-CO8A [desc:"safe-deploy.sh omits check-identities/check-guards - deploy green does not mean CI green; run compile gates before push", keywords: safe-deploy_missing_gate check-identities_not_in_safe-deploy CI_failed_identity_check_but_local_deploy_green push_after_deploy_failed_CI, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

scripts/safe-deploy.sh runs types/lint/tests/esbuild/smoke/restart but NOT check-identities or check-guards — VERIFIED 2026-08-02 (grep 0 hits; a home-path-shaped example in a code comment sailed through safe-deploy green and failed only in CI — do not spell such an example even in THIS note, the checker scans memory pages too). Before pushing, run pnpm run check-identities (or full pnpm run compile) even when safe-deploy reports DEPLOYED green. [^21]




^ATOM-SFLG-1NSX [desc: "cp over an existing Mach-O in place gets every exec SIGKILLed (exit 137, silent) on macOS — deploy with rm+cp (fresh inode), verify codesign -v", keywords: server_exited_during_startup_wrote_nothing exit_137_no_output sigkill_on_exec_after_cp code_signature_invalid_kill cp_over_binary_breaks_signature deploy_alcore_binary_rm_first bin-native_copy_dies_silently macos_kills_replaced_mach-o fresh_inode_fixes_signature codesign_-v_after_deploy, trdd: TRDD-ZIWEB0UW, ocd: 2026-09-01, lmd: 2026-09-01]

In-place cp over an existing signed Mach-O binary (cp src bin-native/darwin-arm64/alcore onto the OLD inode) makes macOS SIGKILL every subsequent exec of it with ZERO output (exit 137, nothing on stdout/stderr) — the kernel's cached code-signature no longer matches the rewritten pages. The failure masquerades as 'the server exited during startup and wrote nothing to server.log'. Deploy binaries by rm + cp (fresh inode: the ad-hoc signature is re-associated and codesign -v passes) or cp to a temp name + mv. Diagnosed 2026-09-01: the first deploy of the day worked by luck; the second left the live server unstartable until the fresh-inode copy. [^24]


## Governed by

- [[agentlenspro-ops-lessons]] — the operational-doctrine overview this sub-page details.

## Notes and lessons learned

[^1]: [id:ATOM-SETTINGS-WIPE-GUARDRAIL, status:valid, keywords:"config_file_wiped_or_corrupted_after_edit settings.json_wiped safeConfigEdit_guard start_fresh_on_parse_failure_removed", ocd:2026-07-11, lmd:2026-07-11] promoted from the old-repo LOCAL note
  `config-writes-only-via-safe-editor` so the fork's contributors inherit it — the wipe
  incident predates the fork but the guarded code (`src/safeConfigEdit.ts`) is in this
  repo.
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
[^17]: [id:ATOM-7U4Z-2V6H, status:valid, desc:"resolve a setting the way the tool resolves it, and don't route around a guard that disputes you", keywords:"setting_present_in_config_but_not_taking_effect is_this_knob_actually_live config_declared_in_several_files prove_which_file_the_tool_reads guard_disagrees_with_my_analysis", ocd:2026-07-31, lmd:2026-07-31] DO NOT conclude a setting is live (or dead) from reading the config files, BECAUSE a tool reads only the file IT reads — here three files declared the same knobs and pnpm 11 honoured exactly one, so both "the safeguard is disabled" and "package.json is authoritative" were confidently wrong in opposite directions. DO falsify each layer separately: one scratch dir per source plus a no-config control, and make the sources DISAGREE so the winner is identified rather than merely present. DO NOT route around a safety guard once your test contradicts it, even holding proof, BECAUSE the guard encodes someone else's model of the same risk and being right about the mechanism is not the same as being right about the consequence. DO report the conflict and leave the decision to the human who owns the override.
[^21]: [id:ATOM-SFJF-ZAN0, status:valid, desc:"Leak-shaped examples are leaks to a shape-based checker - even inside the note describing the incident", keywords:"identity_check_flags_memory_page home_path_example_in_note check-identities_scans_memory example_path_blocks_CI defang_examples_in_docs", ocd:2026-08-02, lmd:2026-08-02] DO NOT spell a home-path-shaped or email-shaped example literally in ANY tracked file — including PROJECT memory pages — BECAUSE check-identities is shape-based and scans everything tracked/shipped, so the example itself blocks CI (it did, twice today: a code comment, then the memory note DESCRIBING that incident). DO describe the shape in words (a home-path-shaped example) or use the documented placeholders.
[^23]: [id:ATOM-D1ML-AFSH, status:valid, desc:"the same pnpm 'safeguard disabled' proposal has now been refused TWICE — a refusal does not suppress the janitor's re-proposal", keywords:"janitor_proposes_the_pnpm_safeguard_is_disabled_again package-manager_safety_knob_disabled_ticket PKGPOL-001_keeps_coming_back I_already_refused_this_proposal_why_is_it_back dedupe_key_did_not_suppress_a_refused_ticket second_refusal_of_the_same_finding", ocd:2026-08-05, lmd:2026-08-05] DO NOT re-adjudicate this finding from scratch when the janitor proposes it AGAIN, and do not dispatch its agent on approval, BECAUSE it has now been refused TWICE on the same false premise — TRDD-JJFGDV3W, then TRDD-9COGK66W on 2026-08-05 — and `ticket-dedupe-key: PKGPOL-001:package-manager config` did NOT suppress the second one. A refusal records the verdict; it does not stop the detector. So the cost recurs every time unless someone recognises it, which is exactly what this lesson is for. DO run the ONE command that settles it — `pnpm config get minimumReleaseAge trustPolicy blockExoticSubdeps` — and refuse again if it reports 7200 / no-downgrade / true (it did on 2026-08-05). Note the trap that makes the proposal plausible: its body is mechanically CORRECT (pnpm ignores `package.json#pnpm`) and only its CONCLUSION is wrong, so skimming it reads as sound. Dispatching is worse than wasteful — the proposed fix edits `package.json#pnpm`, which the janitor's own `pkg-manager-guard` hook refuses, pitting a janitor agent against a janitor guard over a non-problem. The dedupe failure belongs upstream in the janitor plugin, never as an edit from here.
[^24]: [id: ATOM-6YV6-QSQP, status: valid, keywords: "deploy_repeated_the_in-place_cp recall_the_deploy_page_before_copying_bin-native exec_gate_exit_code_64_usage_error binary_still_does_not_exec_false_alarm nonzero_exit_is_not_sigkill test_for_exit_137_specifically alcore_--version_exits_64 server_start_aborted_by_a_wrong_gate second_time_this_trap_hit codesign_valid_on_disk_but_still_killed", ocd: 2026-09-02, lmd: 2026-09-02] DO NOT deploy `bin-native/darwin-arm64/alcore` with a bare `cp` over the old file, and DO NOT gate "the binary executes" on exit 0, BECAUSE this trap hit AGAIN on 2026-09-02 (one day after this atom was written — the deploy was done from the O3ICDRLO card's prose, not from this page) and then a second bug hid the fix: `alcore --version` has no such flag and exits 64 ("command required"), so a gate written as `"$B" --version || ABORT` declared the freshly-inoded, perfectly runnable binary "still killed" and refused to start the server. DO recall this page before any bin-native copy (`memgrep recall deploy_alcore_binary_rm_first`), copy with `rm`/`mv` + `cp` (fresh inode), and test exec by checking for exit 137 specifically — any OTHER exit, including 64, proves the kernel let it run. `codesign --verify` passes on the stale inode too, so it cannot detect this.
