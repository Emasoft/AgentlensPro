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
Context: the refused proposal TRDD-JJFGDV3W, which claimed the safeguard was "disabled". [^17] [^23]


^ATOM-DMTT-DOCU [desc:"A segment past ~512 MB throws in readFileSync — it killed setup and silently deleted two days from every query", keywords: Cannot_create_a_string_longer_than_0x1fffffe8 setup_exits_1_on_a_big_store readFileSync_throws_on_a_huge_file span_segment_over_512MB a_whole_day_missing_from_query_results max_string_length, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

A span segment can grow past V8's max string length (~512 MB), and `fs.readFileSync(f,"utf8")` THROWS there — "Cannot create a string longer than 0x1fffffe8 characters". The store caps nothing by design (no eviction; retention deletes whole expired days), so a busy day reaches that size on its own. Measured 2026-08-02: two live segments at 568 MB and 531 MB broke BOTH readers — `agentlenspro setup` exited 1 outright, and `segmentedSpanStore.loadRange` dropped those two whole days from every query inside a `catch { continue }`, with no log line. Every NDJSON walk now goes through `src/ndjsonLines.ts` (chunked reads + a StringDecoder so a UTF-8 sequence split across a chunk boundary is not corrupted), and the store logs a read failure by segment name instead of continuing silently. [^18]


^ATOM-K3U3-GHM5 [desc:"The file-scanning identity check cannot see outbound posts — a second guard covers gh", keywords: check-identities_is_green_but_an_address_is_public agent_pasted_an_account_table_into_an_issue email_leaked_in_a_github_comment redact_a_published_comment guard_scans_files_not_posts, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An identity guard that scans FILES cannot see what an agent POSTS. On 2026-08-02 `check-identities` was green while three of the owner's real email addresses sat in three PUBLIC GitHub issue comments (AgentlensPro#8, ai-maestro#95, ai-maestro#102) — agents had pasted `get_account_status --all` and `lifetime-status.sh` tables, whose every row carries an account's email, straight into a comment. The check was not broken and needed no fix: its scope is tracked and shipped files, and a comment is neither. The second enforcement point is `scripts/deny-identity-leak-to-github.js` (PreToolUse on Bash), which scans any `gh` verb that publishes prose — including the body it would read from `--body-file`, the shape all three leaks actually took — and denies on an email or a real-username home path. Verified by replaying the real leaked body through it: denied, all three addresses named masked. [^19] [^20]


^ATOM-N20K-LDOD [desc:"A bare @handle in GitHub prose pages a real user; backtick it, and use mentions: to find real pages", keywords: at-mention_paged_a_stranger_on_github @manager_@janitor_notified_by_mistake how_to_write_a_handle_without_pinging mentions_search_qualifier_vs_text_search, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An `@name` written in GitHub prose PAGES the account with that handle, and the handles agents reach for are already taken by real people. On 2026-08-02 agents writing role names in issue bodies notified two strangers across 9 issues (confirmed with the authoritative `mentions:<user>` search qualifier — NOT with a text search for the handle, whose 932 hits were GitHub tokenising the word and matching every prose use of it). The fix is one character each side: wrapped in backticks the handle renders as code and notifies nobody. The outbound guard `scripts/deny-identity-leak-to-github.js` now denies a bare mention in any `gh` post, stripping fenced and inline code first so the backticked form still passes.


^ATOM-R4X7-VMJ1 [desc:"DuckDB ignore_errors emits all-NULL rows for bad NDJSON lines - count verifies pass, degradation invisible without count(col)", keywords: duckdb_ignore_errors unparseable_ndjson_line all-NULL_row seal_verify_passes torn_line_silently_lost count_matches_but_data_degraded, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

DuckDB read_json_auto with ignore_errors=true does NOT drop an unparseable NDJSON line — MEASURED (2026-08-02): it lands as an all-NULL row, so a row-count verify passes and cannot detect the degradation. A truncated-after-a-value object is even silently REPAIRED (closed at EOF) and parses fully. Consequence for any seal/convert-verify design: count a required-always column (count(ts) < count(*)) to see NULL-ified torn lines; a count(*) match proves nothing about line integrity. Regression: src/test/statuslineSealAndFilter.test.ts.


^ATOM-POFB-CO8A [desc:"safe-deploy.sh omits check-identities/check-guards - deploy green does not mean CI green; run compile gates before push", keywords: safe-deploy_missing_gate check-identities_not_in_safe-deploy CI_failed_identity_check_but_local_deploy_green push_after_deploy_failed_CI, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

scripts/safe-deploy.sh runs types/lint/tests/esbuild/smoke/restart but NOT check-identities or check-guards — VERIFIED 2026-08-02 (grep 0 hits; a home-path-shaped example in a code comment sailed through safe-deploy green and failed only in CI — do not spell such an example even in THIS note, the checker scans memory pages too). Before pushing, run pnpm run check-identities (or full pnpm run compile) even when safe-deploy reports DEPLOYED green. [^21]


^ATOM-2MG5-ACR9 [desc:"No API reports cache liveness — every freshness verdict is inferred from local evidence; cache-expired and last-compact cost zero tokens (verified 3 ways), but not zero time", keywords: does_cache-expired_cost_tokens is_the_cache_expiry_check_free how_do_I_know_if_the_cache_is_really_alive api_for_cache_liveness cache_verdict_is_inferred_not_measured zero_token_diagnostic, type: project, ocd: 2026-08-04, lmd: 2026-08-04]

There is NO API that reports whether a prompt-cache entry is still alive, so every cache-freshness verdict AgentlensPro gives is an INFERENCE from local evidence (last api_request timestamp vs the session's TTL regime) — by design, not as a shortcut. The only ground truth is to send a request and read cache_read vs cache_creation in the response, and if the cache HAD expired that probe itself pays the full rewrite, so an exact zero-cost answer is impossible in principle. Consequence: agentlenspro cache-expired and last-compact consume ZERO tokens — verified 2026-08-04 three ways: (1) the path is cacheExpiredCli -> callTool -> http://localhost:4316/mcp, and the server side is assessCacheExpiry (pure math) + getTtlContext -> getCurrentAccount -> readFileSync(~/.claude.json); (2) the three api.anthropic.com strings in the CLI bundle belong to OTHER verbs and are unreachable from these paths — /api/oauth/profile and /api/oauth/usage (subscriptionUsage.ts, account metadata) and /v1/messages/count_tokens (exactTokens.ts, ctxmap's exact measurement); (3) neither new module imports either file. Zero tokens does NOT mean zero cost: see TRDD-CXPLAT01 for the 20-40s probe latency measured the same day.


^ATOM-KRXC-PSWU [desc:"The MCP transport had NO connect bound (75s stalls); the fix is a CONNECT deadline, never a request timeout — server-side slowness is legitimate", keywords: CLI_hangs_75_seconds cache-expired_takes_forever command_stalls_when_server_unreachable http.request_has_no_timeout connect_timeout_vs_request_timeout address_drops_instead_of_refusing, ocd: 2026-08-04, lmd: 2026-08-04]

**A hot-path CLI verb must bound the CONNECT — and only the connect.** `rpc()` / `apiRequest()` called
`http.request` with no bound at all, so an address that DROPS (a firewall blackhole, a suspended
container, a VPN flap) held the process until the OS connect timeout. MEASURED 2026-08-05:
`agentlenspro cache-expired` took **75,103 ms** — a verb whose documented purpose is answering when the
server is DOWN. Fixed by an 800 ms connect deadline (`AGENTLENS_CONNECT_TIMEOUT_MS`), cleared on
`connect` for a fresh socket and on `response` for a pooled one; 873 ms after, exit 2, with a reason
that names the cause. Commit cc5326c, TRDD-E8XIC2PM.

**Bound the CONNECT, never the request.** A legitimate call can be slow SERVER-side — `ctxvis` spawns
an agent and measures two of its turns — so an idle-socket timeout kills correct work, while an
unanswered connect is never anything but a dead endpoint.

**Two traps this class hides behind.** (1) A closed port REFUSES instantly; only an address that DROPS
(`10.255.255.1`) reproduces the stall, which is why a thorough "server down" suite stayed green for
weeks while three commands took 10.6 s each. (2) `AbortSignal.timeout` bounds the REQUEST, not the
PROCESS: the aborted socket keeps the event loop alive, so a CLI that ends by setting `process.exitCode`
still waits it out — see `exitNow` in `src/cli/main.ts`, which must ALSO flush stdout first, because
`process.exit()` discards a queued pipe write past ~64 KiB (measured: 262,144 written, 65,536 received). [^22]


^ATOM-WPOI-PJMS [desc:"The verified transaction protects the FILE, not your INTENT: an op carrying a computed RESULT (set/delete) reintroduces the very race the lock closes", keywords: safe_config_edit_clobbers_another_tool's_hook transaction_lock_did_not_prevent_the_overwrite whole-array_set_is_stale settings.json_entry_disappeared ops_must_carry_predicates, ocd: 2026-08-04, lmd: 2026-08-04]

**`safeConfigEdit` protects the FILE, not your INTENT.** The lock, the verify-diff and the atomic
rename are all real — and an op that carries a computed **RESULT** still clobbers a concurrent writer,
because the value was computed from a read taken BEFORE the lock and the transaction faithfully writes
exactly what it was asked for. The verify-diff cannot catch it either: the change IS inside the declared
op path, which is the one thing it checks.

Found in our own hook installer (TRDD-T0CT9U4X, commit 4da41dc): the strip path committed
`{op:'set', path:['hooks',ev], value:<array computed pre-lock>}`, so a hook ANOTHER tool appended to
that event in between was silently deleted — from the user's `~/.claude/settings.json`, by the tool
whose transaction exists because this project once destroyed one. `{op:'delete'}` is the same defect in
a different op: "this array is now empty" is also a pre-lock conclusion.

**RULE: ops carry PREDICATES, never results** — `append_unique` to add, `remove_by_substring`
(+`prune_empty`) to strip. Two constraints that follow: the predicate crosses a process boundary into
Python, so it must be DATA (a substring, never a regex or a callback); and a needle is matched against
`json.dumps(element)`, so it must be a literal JSON does not escape — a command containing a tab or a
quote will never match its own raw text, and a caller that cannot express a removal must say so and
fall back loudly rather than emit a filter that strips nothing while reporting success.


^ATOM-9B2N-KU2R [desc:"CLI help is TOTAL since 2.23.0: --help/-h anywhere in argv routes to help and dispatches NOTHING — before that, disable --help EXECUTED the disable", keywords: help_flag_executed_the_command disable_--help_disarmed_everything --help_ran_the_verb help_must_dispatch_nothing MANAGEMENT_VERBS help-total_contract, type: project, ocd: 2026-08-05, lmd: 2026-08-05]

Since v2.23.0 the CLI help contract is TOTAL (git/npm style): `--help`/`-h` ANYWHERE in argv routes to help and dispatches NOTHING — enforced by an intercept in `cliMain` (src/cli/main.ts) BEFORE the dispatch switch, with a `MANAGEMENT_VERBS` set gating network-free help for management verbs. WHY it must be this way: on 2026-08-05 `agentlenspro disable --help` EXECUTED the disable — it armed the DISABLED flag, stopped the server, and disarmed every hook machine-wide, because the old dispatcher matched the verb first and passed `--help` through as an ordinary arg. Any new verb added to the CLI inherits the intercept automatically; never add a verb-local `--help` handler that runs after side effects. Falsified tests: src/test/cliDispatch.test.ts ("help is TOTAL", 4 tests that failed 0/4 against the pre-fix bundle).


^ATOM-LSGO-AIXS [desc:"Two 2026-08-06 bugs, one shape: the DETECTOR and the REPAIRER disagreed about the same condition, so setup reported drift forever and the repair could never land", keywords: setup_reports_drift_every_run_but_never_fixes_it repairer_detects_but_cannot_repair remove_by_substring_still_present_after_apply hook_re-registration_fails detector_and_writer_disagree a_converge_path_that_is_never_exercised setup_aborted_fail-fast_on_hooks, type: project, ocd: 2026-08-06, lmd: 2026-08-06]

**A detector and its repairer must agree on the condition, or `setup` reports drift forever and never fixes it.** Hit TWICE on 2026-08-06, in unrelated code, with the identical signature — `setup` names a problem, claims to act, verifies, and FAILS, on every run.

1. **Raw-body key (`telemetryConfig.ts`).** `cli/setup.ts` tested key PRESENCE; the writer's delete guard tested a VALUE match against `file:${bodiesDir}` resolved with capture OFF — which is the LEGACY dir by construction and can never equal a key holding the SPOOL path. Fixed by `ownedBodyValues` (every `file:` value the installer could have written).
2. **Hook re-registration (`scripts/safe_config_edit.py`).** Re-registration IS `remove_by_substring(<cmd>)` then `append_unique(<cmd>)`. `verify_diff` asserted the removal's postcondition against the FINAL tree — after the append had legitimately re-added the needle — so it could never hold (`'agentlenspro gate' still present after apply`), and fail-fast then skipped skill/otel-env/server/final-test. Fixed by exempting exactly the values LATER ops on the same path re-add.


^ATOM-TMP3-BABT [desc:"A converge path only runs when something has actually drifted, so a green setup exercises the DETECTOR and none of the REPAIRER", keywords: why_did_the_broken_repair_path_go_unnoticed a_green_setup_proves_nothing_about_the_repairer how_do_I_test_a_self-repairing_installer converge_path_never_exercised detection_and_repair_in_different_languages, type: project, ocd: 2026-08-06, lmd: 2026-08-06]

**A green `setup` on a healthy machine proves the DETECTOR works and proves NOTHING about the REPAIRER.** This is why both 2026-08-06 convergence bugs stayed invisible for so long: a converge is only attempted when something has genuinely drifted, so every healthy run ("registrations current", "telemetry env current") emitted no ops and exercised no repair code at all. The repair path was dark until the day it was needed — which is precisely the day it has to work.

**How to test one: break something first.** Run the repair against a genuinely drifted fixture, not a converged one. When detection and repair live in different files — or different languages, as here (a TypeScript detector and a Python writer) — pin their SHARED predicate with such a test, plus a counter-case, so a widened predicate cannot quietly degrade into "never assert". Both fixes ship exactly that pair.


^ATOM-WOXQ-R1EO [desc:"A skip-optimization scoped to the wrong unit of work: skipping the re-ingest of an already-durable body also skipped its DELETE, so a fixed-size spool filled until capture died", keywords: spool_never_drains spool_100%_full raw_body_capture_stops_silently skipNames_strands_files file_ingested_but_never_deleted skip_optimization_skipped_the_delete_too ram_disk_fills_with_already_durable_files, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`ingestPass` filtered `skipNames` out of the candidate list at the top of the pass. The set is
seeded each boot from every `src_name` already in the Parquet store, and the intent was sound —
do not re-read and re-hash a body the store already holds. But the candidate list is also what
feeds the verify-then-DELETE gate, so the filter silently bought the read saving by giving up the
reclaim: a durable body could never be deleted.

On an unbounded disk that is invisible waste. On a fixed-size RAM spool it is terminal — the spool
accumulates exactly the files the store already has, reaches 100%, and raw-body capture stops with
no error anywhere. Measured 2026-08-06: 3,615 bodies stranded in a 2 GB spool, ~300 KB of headroom
left, bodies being dropped. Fixed in `65207f4`: the skip applies to the INGEST only; an
already-durable file still goes through the same gate (re-read, re-proven byte-identical plus its
`(src_name, capture-ts)` row) before the unlink.

**DO NOT** scope a skip-optimization to a whole pass when the pass does more than the work you meant
to skip, BECAUSE the cheapest place to write the filter (one `.filter()` at the top) is also the
place that silently drops every OTHER stage the candidate would have reached. **DO** apply the skip
at the stage it names — here, guard the `ingestBody` call, not the candidate list — and assert the
other stages still run on skipped items.


^ATOM-2SUG-QGT8 [desc:"The bodies pass logged only when ingested > 0, so a pass that reclaimed thousands of files and ingested none printed nothing at all", keywords: pass_did_work_but_logged_nothing silent_success log_gate_on_the_wrong_counter ingested_0_so_nothing_printed reclaim_invisible_in_logs, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`archiveOtelBodies` gated its whole report on `if (ingested > 0 || purged.length > 0)`. Once the
reclaim path could run without ingesting anything, a pass that deleted thousands of files printed
NOTHING — so the operator's only window onto the drain showed silence, which reads identically to
"nothing to do". That is a large part of why the stranded-spool bug survived as long as it did.

**DO NOT** gate a whole report on ONE of several counters, BECAUSE the counter you picked can be
legitimately zero on a healthy path and then the report disappears exactly when the other work is
happening. **DO** gate on the disjunction of every counter the report mentions (`ingested > 0 ||
deleted > 0 || purged > 0`), and print each one so a zero is a stated fact rather than an absence.


^ATOM-N4OI-OY30 [desc:"Reclaim runs ~1 file/s against ~0.8 files/s of arrivals, so a backlog clears over hours — judge a drain by deletions-from-a-snapshot, never by net file count", keywords: spool_still_full_after_the_fix did_the_deploy_work drain_rate net_file_count_hides_arrivals measure_deletions_not_totals backlog_takes_hours, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

Measured 2026-08-07 on the spool drain: 120 files deleted per 2 min against 94 arriving. The net
count moved by only −26, and at one sample it moved UP — so "the file count is not falling" and
"still 99% full" are both compatible with a drain that is working. Each reclaim reconstructs the
body from DuckDB to prove it before unlinking, which is what caps throughput near 1 file/s; a
multi-GB backlog therefore takes hours, and a pass in flight logs nothing until it finishes.

**DO NOT** judge a drain (or any producer/consumer reclaim) by the total item count or free space
minutes after a deploy, BECAUSE arrivals and deletions are superimposed in that one number and a
healthy drain can look flat or negative. **DO** snapshot the item NAMES, re-snapshot later, and
count the two directions separately (`comm -23` deleted vs `comm -13` arrived) — that is the only
form that distinguishes "not draining" from "draining slower than it fills".


^ATOM-2IIQ-XI6J [desc:"The bar every model-facing hook message must clear: own-project, actionable now, significant — anything else belongs in the CLI/dashboard, not an interruption", keywords: what_may_a_hook_say_to_an_agent advisory_got_removed why_doesn't_the_fan-out_warning_fire hook_noise_policy agent_context_injection_rules model-facing_text_bar, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

Ratified 2026-08-07 after an audit of what the gate hooks actually injected. Text AgentlensPro puts
in front of a MODEL must clear all three:

1. **OWN PROJECT** — never another project's session id, path, or agent types. Scoping matches the
   caller's own SESSION first and its cwd second: a worktree-isolated subagent runs in a different
   directory by design, so cwd alone silenced the advisory for exactly the fan-out shape most
   likely to be expensive. It fails QUIET — an unidentifiable caller gets silence, because an
   unprovable match must not become a claim.
2. **ACTIONABLE NOW** — the caller can change what it is about to do. "Go run investigate_burn
   later" is a CLI answer, not an interruption.
3. **SIGNIFICANT** — a real anomaly, not the expected cost of normal work.

Failing that bar cost two advisories outright (`FAN_OUT_COLD_START`, whose own text ended "No
action needed"; `THRASH_UNATTRIBUTED`, about writes provably attributable to nobody) and stripped
foreign identities from the denies, the stall messages, and the thrash suspects. Nothing left the
DETECTION — but be exact about what that does and does not mean, because the comfortable version of
this sentence was wrong: `thrash.unattributed` and `coldStartSessions` had NO consumer outside the
gate, so they are still computed and now surfaced NOWHERE. Giving them a home is open work.[^24]

**DO NOT** add a hook message because it explains a real finding, BECAUSE each of the removed ones
was added exactly that way — to help a HUMAN reading a debug session — and explaining is not
interrupting; the reader in production is a busy agent that cannot act on it. **DO** ask the three
questions above before adding any hook text, and put anything that fails them behind an explicit
request instead. [^24]


^ATOM-OLKB-N7AV [desc:"Every gate code has TWO model-facing emitters — buildAdvisory (PostToolUse) and evaluateAgentGate (PreToolUse warn) — so changing one leaves the other firing", keywords: removed_the_advisory_but_it_still_fires gate_code_emitted_twice PostToolUse_advisory_and_PreToolUse_warn_twin changed_buildAdvisory_but_the_warning_persists, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`src/agentGate.ts` reaches a model through two independent paths that share the same code names:

- `buildAdvisory(state)` → PostToolUse → `hookSpecificOutput.additionalContext`
- `evaluateAgentGate(...)` → PreToolUse → `systemMessage` (warn) / `permissionDecisionReason` (deny)

`THRASH_UNATTRIBUTED` and `FANOUT_HEADSUP` each existed in BOTH. Removing one branch leaves the
other emitting the identical message, and the tests for the two live in different suites, so a
green run proves nothing about the twin.

**DO NOT** treat a gate code as fixed after editing `buildAdvisory`, BECAUSE the PreToolUse twin is
a separate branch a hundred lines away that no failing test will point you to. **DO**
`grep -n "'<CODE>'" src/agentGate.ts` and expect TWO hits before believing a change is complete —
and remember the deny path renders through a third field again.


^ATOM-GZJG-RS6I [desc:"Streaming the FILE fixed half of it — loadRange still held every span, so an unbounded query OOM'd the server at 4GB", keywords: server_died_on_a_tool_call socket_hang_up_pid_changed JavaScript_heap_out_of_memory Ineffective_mark-compacts get_cache_event_log_kills_the_server unbounded_query no_--window loadRange_materializes streaming_the_file_is_not_streaming_the_query, type: reference, ocd: 2026-08-07, lmd: 2026-08-07]

**Reading incrementally while accumulating everything is still O(all).** ATOM-DMTT-DOCU made
`segmentedSpanStore.loadRange` stream each segment through `ndjsonLines.ts` instead of one
`readFileSync` — which fixed the >512 MB *string* limit and looked like "the store streams now". It
did not: every in-window span was still pushed into ONE returned array. So on 2026-08-07
`agentlenspro get_cache_event_log` with no `--window` (the default — `windowHours` is optional and
`undefined` means all of history) materialized ~1M span objects to keep the `api_request` ones, and
died with `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory`
at ~4 GB after 62 s. Memory tracked the WINDOW, not the answer: 1 h→19 MB, 24 h→478 MB, 168 h→dead,
for a result that was 7 rows at every size. It degrades with store age rather than failing on day
one, which is how it shipped.

Fix: the store exposes `forEachInRange(since, until, visit)` and `loadRange` is a thin wrapper over
it, so a selective reader's peak memory follows what it KEEPS. Measured after, across a 168× window
range: 69/121/147/170 MB; the unbounded query now completes in 36 s over 184,212 calls.

Three things worth carrying:
- **The default was NOT capped.** A window cap hides an accumulation instead of removing it, and
  turns a legitimate full-history question into a silently partial answer.
- **One server owns the machine's data dir**, so a tool that OOMs stops ingestion for EVERY project
  — a per-tool memory bug is a machine-wide outage.
- **The silence was already solved.** `mcpServer.ts` logs `tool <name> start` precisely because a
  wedged or aborted handler never logs a completion: the last start with no matching `done` IS the
  culprit. An OOM is a fatal V8 abort, uncatchable, so nothing in-process could say more.


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


^ATOM-PJAW-P8XT [desc:"The delete gate's read-back is served from the page cache, so it proved readability not durability; the fsync barrier is gated on whether the SOURCE was durable, and F_FULLFSYNC is unavailable in Node", keywords: is_the_parquet_part_actually_durable_before_we_delete_the_source verify_before_delete_page_cache does_fsync_guarantee_data_on_disk_macos F_FULLFSYNC_not_available_in_node reclaim_only_1_file_per_second duckdb_round_trips_per_file_in_the_delete_gate, type: project, ocd: 2026-08-12, lmd: 2026-08-12]

**A read-back proves READABILITY, not DURABILITY — the page cache answers it.** The universal
delete gate (`src/store/ingestPass.ts`) flushes Parquet, reconstructs each body FROM the store,
compares sha256 against the source file's own bytes, and only then unlinks. That ordering is
sound, but `flush()` never fsynced, and the comment above it called the part "durable". A read
issued microseconds after a write is served from the OS page cache, so the gate could pass on
bytes that had not reached the platter.

**Severity depends ENTIRELY on whether the SOURCE was durable, which is why the barrier is gated
rather than global.** Draining the RAM-disk spool: the source is volatile anyway, so a power loss
takes it either way and the barrier buys ~nothing. Draining the LEGACY SSD bodies dir: the source
was safely on disk, and deleting it after a non-durable flush can lose data that was already
safe. The spool back-pressure valve redirects INTO that SSD dir under pressure, which is what
turned this from latent to live.

**`fs.constants.F_FULLFSYNC` is `false` in Node (verified empirically).** So on macOS pure Node
cannot force the drive's own write cache to media — `fsync(2)` asks the OS to flush its buffers to
the device, which is a real improvement over never asking, but not a guarantee against power loss
on a drive with a volatile cache. Say that, do not claim more.

**Throughput: the gate was ~2 DuckDB round trips PER FILE** (reconstruct, then the row/ts query),
so a 200-file batch was ~400 round trips ⇒ ~1 file/s (~53 MB/min) against ~80 MB/min burst inflow.
That inequality — not flush cadence, not spool size — is what dropped bodies. Batched to one bulk
row/ts query plus chunked reconstruction (32/query, NOT unbounded: 200 × ~881 KB is ~176 MB of
strings in one result set) ⇒ ~15 round trips. **What is proven did not change, only how it is
executed** — and a body missing from the bulk result map must default to NOT-ok, so a silently
dropped row can never authorize a delete.


^ATOM-OL89-HIFU [desc:"freePort is a TOCTOU claim; two mitigations are needed, the retry must match the PORT TEXT not a bare exit(1), and npx mocha <file> does not isolate because .mocharc adds a spec glob", keywords: port_already_in_use_in_CI_but_passes_on_rerun flaky_test_only_on_one_matrix_leg freePort_race_between_probe_and_listen retry_swallowed_a_real_startup_failure npx_mocha_single_file_still_runs_whole_suite mocharc_spec_glob_does_not_isolate, type: project, ocd: 2026-08-12, lmd: 2026-08-12]

**A "free port" probe is a TOCTOU claim with a very short shelf life.** The classic helper —
`listen(0)` → read the port → `close()` → resolve — proves the port was free AT PROBE TIME only.
Between that close and the child's own `listen()`, the OS may hand the same ephemeral port to
anything, including another test's server in the same run. Retrying the ASSERTION cannot help: the
child already exited. Diagnosed from CI run 31139375893, where `build-and-test (20)` died on
`Port 33097 (OTLP) already in use` while `(22)` passed **at the identical commit** — a leg passing
is what distinguishes a race from a regression.

Two mitigations, because neither alone closes the window: an in-process claimed-set (the only
collision source we can see — mocha runs the whole suite in ONE process) and a bounded spawn-retry
on a FRESH port (a claimant outside this process). Do NOT "fix" it with disjoint per-file port
ranges: that trades a rare race for a permanent collision, and CI runners are not exclusive.

**The retry matcher is where this gets dangerous, and it is subtle.** Matching a bare
`exited early (code=1)` makes EVERY exit(1) retryable — so a genuine startup failure burns three
attempts and is then reported as port contention, with the real reason buried. Match the PORT TEXT
only: both the server's own message and Node's raw `EADDRINUSE` contain "already in use", so no
real port case is lost. This is not hypothetical — `serverSingleInstance.test.ts` asserts a
DELIBERATE exit(1) ("Refusing to start") that such a retry would swallow, and it is one
`spawnServerWithRetry` call away from being wrapped.

**The mocha-isolation trap that bites while verifying this is its own atom — see ATOM-TEPQ-RXBX.**


^ATOM-TEPQ-RXBX [desc:"npx mocha <file> AND --spec both run the full suite here; only --grep narrows, so verify the passing COUNT", keywords: mocha_isolate_single_file run_one_test_file npx_mocha_file_runs_whole_suite --spec_does_not_isolate --grep_narrows_mocha test_passes_in_isolation mocharc_spec_glob, ocd: 2026-08-12, lmd: 2026-08-12]

**No mocha flag isolates a single test FILE in this repo — only `--grep` narrows, and you must
verify the COUNT.** `.mocharc` sets `spec: ['out/test/test/**/*.test.js']`, and a positional
filename is ADDED to that glob rather than replacing it, so `npx mocha <file>` silently runs the
whole suite. Measured 2026-08-12: `--spec out/test/test/serverLogTailScope.test.js` ran all 2239
tests too — identical to the positional form — while `--grep "scoped to THIS attempt"` ran 5 tests
in 21 ms.

**An earlier version of this lesson recommended `--spec` as the remedy.** That is worse than having
no lesson: the reader believes they isolated a file, sees green, and concludes "it passes in
isolation" — the exact false conclusion the lesson exists to prevent, now carrying the authority of
a documented fix. So the durable instruction is not a flag at all: read the `N passing` line and
check it against how many tests that file defines. A count is evidence; a flag is a hope.

Practical consequence: a full-suite run is ~1 min here, so "isolation" is rarely worth chasing. Use
`--grep` when you genuinely need one test (falsification runs, where an unrelated red would muddy
the result), and otherwise just run the suite and read the delta against the known baseline.


^ATOM-CVM9-3JPN [desc:"heap was the wrong number: 67% of the footprint is off-heap, and a silent kill means SIGKILL on RSS, not a V8 heap OOM", keywords: server_killed_silently server_OOM_not_heap rss_vs_heap_node max-old-space-size_does_not_bound_rss requests.log_heap_only ineffective_mark-compacts server_restarted_fresh_pid off-heap_duckdb_memory how_to_diagnose_a_process_kill, ocd: 2026-08-12, lmd: 2026-08-12]

**Heap alone cannot diagnose this server's death — ~67% of its footprint is off-heap, and
`--max-old-space-size` bounds neither that nor RSS.** Measured 2026-08-12 on a HEALTHY server: heap
860 MB against RSS 2624 MB (DuckDB's native arena, buffers, the segment index). So the OOM
post-mortem in TRDD-34B9JAZK stalled three separate times on a number that could not answer it —
`requests.log` recorded heap ONLY, and heap sat at 1768 MB against a 6144 MB cap right up to the
kill, which reads as perfectly healthy.

**The discriminator is whether the death ANNOUNCES itself.** A V8 heap OOM prints `FATAL ERROR:
Ineffective mark-compacts near heap limit` — the out-of-process run did exactly that at ~4 GB. The
server instead went SILENT for 68 seconds and returned as a fresh pid, which is the signature of an
external SIGKILL, and an external kill acts on RSS. So "the server hit its heap limit" was never
supported by the evidence that was collected for it.

Every logged line now carries `heap=…MB rss=…MB` from a SINGLE `process.memoryUsage()` call — two
calls would sample different instants and could report `rss < heap`, which is impossible and would
discredit the trace it exists to make trustworthy. The crash itself is NOT fixed; this is the
instrumentation that makes the mechanism establishable. See ATOM-GZJG-RS6I for the earlier,
genuinely-fixed half (loadRange materializing every span).


^ATOM-E5VV-1E9P [desc:"a fixture re-reading Date.now() across the code's own setImmediate yield; and 'flaky under load' was a false premise — it failed 7/20 in isolation", keywords: flaky_test_under_load test_fails_intermittently_identical_code wall_clock_in_test_fixture Date.now_re-evaluated_per_call setImmediate_yield_changes_timestamp tie-break_picks_wrong_session isolate_the_test_and_count_failures mine_!==_foreign, ocd: 2026-08-12, lmd: 2026-08-12]

**A test fixture that re-reads the wall clock is nondeterministic wherever the code under test
yields.** `cacheExpiry.test.ts` built its shared timeline as `() => [apiRequestAt(iso(1))]`, so
`Date.now()` was sampled fresh on EVERY call. `getTimeline` runs once per session
(`mcpServer.ts:2013`) and `scanWithBudget` awaits `setImmediate` between items
(`mcpServer.ts:3053`), so the later-processed card got a strictly newer millisecond and the
strict-greater tie-break `ms > newestMs` (`mcpServer.ts:2157`) crowned whichever card the scheduler
reached second. Fix: capture the value ONCE (`const activityAt = iso(1)`).

**The PRODUCT code was correct and unchanged** — strict-greater over millisecond timestamps with a
real yield is right for real sessions. Two independent signposts had already said so and both were
walked past: the comment two lines above the defect warned that a per-card timestamp "would let the
precision ranking, not the scope filter, decide the winner" (the fixture created exactly that), and
the same file already defined a frozen `NOW` at line 16, "fixed clock so tests are deterministic",
which this one suite did not use.

**The card's premise was the expensive part, not the bug.** Every sighting called it a
full-suite-LOAD flake, which points the search at cross-test pollution. Measured: 7 failures in 20
runs with that ONE test alone in the process; load raises the rate, it was never required. Before
accepting "flaky under load", run it ISOLATED n times and count — the isolated rate is what tells
you whether the nondeterminism is inside the test or between tests. Evidence 7/20 → 0/20.


^ATOM-C0VK-5JHE [desc:"an unscoped tail of the shared untimestamped server.log quotes foreign history, and a refusal names the pid that WON — so a healthy restart reads as a failure", keywords: refusing_to_start_but_server_is_running restart_looks_like_it_failed server.log_shows_another_pid log_tail_shows_old_errors shared_append-only_log_no_timestamps another_server_already_owns_this_data_directory diagnosis_quotes_foreign_process, ocd: 2026-08-12, lmd: 2026-08-12]

**`server.log` is ONE append-only file shared by every process that ever started a server for a
data dir, and it has NO timestamps — so an unscoped tail quotes other processes' history as if it
diagnosed the command you just ran.** Measured 2026-08-12: 29 accumulated refusal blocks in a 15 MB
log, naming FOUR different owner pids, three lines per block — so a default 8-line tail straddled
~2.7 unrelated eras.

**The inversion is the damage, not the noise.** A refusal names the pid that WON — "another server
(pid N) already owns this data directory" — so a tail printed under a failed command reads as "N
failed to start" when N is the healthy server protecting you. That misreading costs a restart that
was never needed, and on a machine running many sessions a restart interrupts all of them. The
original bug report drew exactly this wrong conclusion, and blamed a retry loop that does not exist
(`ensureServer` spawns ONCE and already reports the SERVING pid, not the child).

Fix: `logTail(lines, fromOffset)` reads only bytes appended since our own spawn (`logSizeNow()`
captured immediately before `spawn`). An attempt that wrote nothing says so; a log rotated underneath
is reported as rotated rather than quoted from a stale offset; the header states the scope, because
"the last 8 lines" and "the last 8 lines WE wrote" are different claims. The guard's message is not
silenced — trading a false alarm for a silent one would be worse.


^ATOM-N8GX-ZQI3 [desc:"suite dies at exit 139 / SIGSEGV in duckdb.node / red tests move between runs — closing a shared DuckDB connection under an in-flight query", keywords: suite_dies_exit_139 mocha_runner_killed_SIGSEGV node_crash_report_duckdb.node test_suite_exit_code_139_no_assertion closeSync_segfault red_tests_move_between_runs duckdb_use_after_free connection_closed_while_query_running, ocd: 2026-08-13, lmd: 2026-08-13]

A SHARED DuckDB connection must never be closeSync()'d while a query can still be in flight on the napi worker thread — the failure is a NATIVE SIGSEGV (ClientContext::Query -> pthread_mutex_lock on freed memory) or an indefinite process wedge, not a JS error. The reachable trigger: mocha's timeout abandons a test mid-await (the promise keeps running), teardown then calls store.close(). Fixed at a43251f: openStore wraps the connection in a Proxy that tracks in-flight calls and refuses post-close ones; close() = interrupt() + drain (Promise.allSettled) + closeSync, single-flight. Per-call instances (withDuck/openDuck) are safe by construction: their finally runs only after their own awaits settle. Pinned by src/test/storeCloseSafety.test.ts (red-first: 2 failing + an 11-minute wedge on unfixed code).


^ATOM-QIF6-MVG7 [desc:"diagnostics answers change between runs / session turn count shrinks / fact DB misses an event the classifier saw — any reader on the raw spool alone is wrong; use bodiesEvidence, memory-flat", keywords: turn_count_shrinks_between_runs fact_db_missing_event diagnostics_answer_changed spool_file_deleted_by_drain evidence_base_volatile indexer_reads_only_spool unclassified_events_preset forensics_db_coverage_gap, ocd: 2026-08-13, lmd: 2026-08-13]

The forensics fact DB (FAL, api_calls) and every raw-body diagnostic MUST source from the store∪spool evidence base (src/store/bodiesEvidence.ts: listBodyEvidence + loadBodyTexts), never the raw spool alone — the ingest drain deletes spool files once Parquet provably holds them, so a spool-only reader's answers change with WHEN you ask (measured: classifier saw 01:08Z, fact DB covered 01:28-01:50; a session's turn count shrank 172→145 between identical queries). Landed c783091 (indexer) + 08e1c35 (cacheBreakTimeline). Two invariants ride along: (1) the union is complete BY CONSTRUCTION via the delete gate; (2) request processing must stay MEMORY-FLAT — derive content tags inside the load chunk and retain only scalars, never raw text (retaining rawText measured ~1.8GB/5h window, the TRDD-34B9JAZK RSS-kill shape). Presets unclassified_events + schema (56eddb0) are the drill-down entry points.


^ATOM-LE8M-IRMJ [desc:"every CLI diagnostic returns rpc error (undefined) / MCP calls all fail but server logs 200s / Already connected to a transport — the shared Protocol instance wedge", keywords: rpc_error_undefined all_mcp_tools_fail already_connected_to_a_transport tools_list_fails cli_cannot_reach_mcp_but_server_up mcp_endpoint_wedged_until_restart one_server_instance_per_connection, ocd: 2026-08-13, lmd: 2026-08-13]

The MCP HTTP endpoint must build ONE SDK Server (Protocol) instance PER CONNECTION — never share one across requests. The SDK's Protocol tracks exactly one transport; a shared instance wedges on overlapping clients with 'Already connected to a transport' and then fails EVERY rpc (tools/list included) as 'rpc error (undefined)' (the CLI's rendering of the 500 body) while the HTTP layer keeps logging 200s — a permanent outage that only a restart clears. Fixed 396d3bb: handleMcpRequest takes a Server factory; each request closes transport + server on response close. createMcpServer is closure-only (no I/O), so per-request instances cost microseconds. Falsification note: the wedge interleave lives in the SDK's async machinery and could not be forced in-process (a sync block serializes the event loop); the recorded red is the live raw-JSON-RPC probe.


^ATOM-57QU-GOU1 [desc:"force-push or history rewrite blocked on main / baseline restore reverted the admin bypass / who may bypass baseline-history-protect on AgentlensPro — owner-ordered deviation, do not restore", keywords: force_push_blocked_on_main cannot_rewrite_history_main non_fast_forward_denied baseline_restore_reverted_bypass history_protect_bypass_owner ruleset_drift_false_positive, ocd: 2026-08-13, lmd: 2026-08-13]

OWNER RULING (2026-08-13, verbatim: 'both the baseline-history-protect and the baseline-pr-and-check must be changed to allows mutations in history and direct pushing/merging by the owner'): on the AgentlensPro repo, baseline-history-protect carries a DELIBERATE deviation from the ratified pair — bypass_actors [{actor_id:5, RepositoryRole, always}] so the owner/admin may force-push and delete on main. Applied 2026-08-13T16:08:34+02:00 via PUT rulesets/18778596; verified current_user_can_bypass=always. baseline-pr-and-checks already carried the identical admin bypass (ratified shape) — no change was needed there. Any baseline-restore/drift pass MUST NOT strip this bypass back to the ratified empty list on this repo — that would revert a Tier-3 owner decision as if it were drift.


^ATOM-R9AC-467C [desc:"A 'timeout under load' in cacheBreakTimeline/forensics tests can be a REAL-STORE scan: since the evidence rewire, storeDir defaults to the live ~/.agentlens store", keywords: test_timeout_under_load cacheBreakTimeline_timeout suite_hangs mocha_timeout scans_real_store storeDir_default non-hermetic_test, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

Since the evidence rewire, `buildCacheBreakTimeline` / `buildCauseCostPeakReport` /
`scanApiCallEvents` default `storeDir` to `dataPath('store')` — the developer's REAL multi-GB
Parquet store. Any test that does not pass a scratch (never-created) `storeDir` silently scans the
live corpus: at machine load ~150 that read as 11 "environmental" timeouts (2026-08-13), and the
tell that broke the environmental theory was an EMPTY-INPUT test ("absent bodies directory") also
"timing out" — no load explains 60s on no data. Isolation pattern: a `noStore` never-created dir
per suite (forensicsIndex.test.ts and cacheBreakTimeline.test.ts both carry it now; fix 4e442c4).
Before blaming load for a red suite, ask: does every store-touching call pass a scratch storeDir?


^ATOM-8309-X2EP [desc:"Sync streaming gunzip exists only via zlib's internal Gunzip._processChunk, and needs BOTH minizlib interceptions: noop handle.close AND restore engine._handle after each call", keywords: sync_streaming_gunzip gunzipSync_memory_spike _processChunk zlib_whole_file_buffer gz_segment_read minizlib, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

Node has NO public sync streaming gunzip — `gunzipSync` returns the whole output (a 568MB sealed
day = the RSS-ratchet allocation). The only sync streaming path is `Gunzip.prototype._processChunk`
(what gunzipSync itself is built on; the minizlib/node-tar mechanism), and it needs BOTH
interceptions per call or it fails subtly: (1) noop `handle.close` for the call's duration (the
sync path closes the native handle when it thinks the one-shot is done), AND (2) restore
`engine._handle = handle` afterwards — the internal `_close()` NULLS it, and un-restored the read
loop stops after ONE chunk, silently truncating output (caught red by the byte-equality test).
Implementation + pinning tests: `src/ndjsonLines.ts::forEachGunzipChunkSync` +
`ndjsonLines.test.ts` (byte-equality vs gunzipSync at many chunk sizes, truncation-throws,
corrupt-throws). Landed ed501db.


^ATOM-5PSZ-R2GD [desc:"zlib delivers an error TWICE (sync throw + async re-emit); _processChunk piles up error listeners per call, and dropping them ALL turns the re-emit into an uncaught crash — keep exactly ONE persistent", keywords: MaxListenersExceededWarning_Gunzip uncaught_unexpected_end_of_file zlib_error_twice removeAllListeners_uncaught _processChunk_error_listener, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

The sync streaming gunzip driver needs a THIRD interception beyond the two in ATOM-8309-X2EP:
`_processChunk` registers a fresh 'error' listener per call (CI's MaxListenersExceededWarning at
11 chunks), but zlib delivers an error TWICE — the sync throw our callers see, plus an async
re-emit on a later tick that those accumulated stale listeners were silently absorbing. Removing
them all (the naive fix) made the truncation test an UNCAUGHT crash. Correct shape: attach ONE
persistent no-op 'error' absorber at engine creation and re-attach it after each per-call
removeAllListeners — flat count, harmless re-emit. Pinned by a warning-capture test
(ndjsonLines.test.ts); landed ed084ff.


^ATOM-LWA9-09CW [desc:"CI red while local slices were green: changing a module's BEHAVIOR contract requires running the suites of its CALLERS, not just the suites of the files you edited (spansScanned flip, ed084ff)", keywords: CI_red_local_green slice_suite_passed_CI_failed forgot_to_run_callers_test_suite contract_test_broke_on_refactor, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

The 9NAUEUUR prefilter changed scanOtelCallEvents' observable contract (spansScanned stopped
counting unparsed spans), and both the worker and the reviewer ran only the suites of the FILES
EDITED (segmentedSpanStore, ndjsonLines) — otelCallEvents.test.ts, which PINNED the old contract,
only ran on CI and went red there. Rule: before claiming green on a behavior change, run the test
suite of every module whose exported function you touched AND of its direct callers (grep the
import); a deliberate contract flip gets the old pin REWRITTEN as a recorded decision, in the same
commit. Landed ed084ff.

## See also

- [[ssd-write-economics]] — what the drain is ultimately protecting: the SSD write budget, why the
  RAM spool is the whole margin, and why batching is only the enabler of compression.

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
[^21]: [id:ATOM-SFJF-ZAN0, status:valid, desc:"Leak-shaped examples are leaks to a shape-based checker - even inside the note describing the incident", keywords:"identity_check_flags_memory_page home_path_example_in_note check-identities_scans_memory example_path_blocks_CI defang_examples_in_docs", ocd:2026-08-02, lmd:2026-08-02] DO NOT spell a home-path-shaped or email-shaped example literally in ANY tracked file — including PROJECT memory pages — BECAUSE check-identities is shape-based and scans everything tracked/shipped, so the example itself blocks CI (it did, twice today: a code comment, then the memory note DESCRIBING that incident). DO describe the shape in words (a home-path-shaped example) or use the documented placeholders.
[^22]: [id:ATOM-QJAG-2CZ8, status:valid, desc:"A test that reads the LIVE capture dir must pass scanCap — uncapped, its runtime is set by the user's traffic", keywords:"test_suddenly_times_out_with_no_code_change test_scans_the_live_capture_directory suite_got_slower_overnight scanCap_in_tests flaky_slow_test_real_corpus", ocd:2026-08-04, lmd:2026-08-04] DO NOT let a test read the live capture directory (`~/.agentlens/otel-bodies` or the RAM-disk spool) without a `scanCap`, BECAUSE that directory grows with the machine's own activity — measured 1,377 → 5,467 files in a single evening — so the test's runtime is a function of how busy the user was, and it will blow its timeout one day with no code change behind it (two did, in the deploy gate, and the first instinct is to hunt a regression that does not exist). DO pass `scanCap` (300 is plenty) and let the report's own coverage block state that it sampled: 120 s+ timeouts became 2.1 s / 2.3 s / 5.5 s and the whole suite went 9 min → 52 s.
[^23]: [id:ATOM-D1ML-AFSH, status:valid, desc:"the same pnpm 'safeguard disabled' proposal has now been refused TWICE — a refusal does not suppress the janitor's re-proposal", keywords:"janitor_proposes_the_pnpm_safeguard_is_disabled_again package-manager_safety_knob_disabled_ticket PKGPOL-001_keeps_coming_back I_already_refused_this_proposal_why_is_it_back dedupe_key_did_not_suppress_a_refused_ticket second_refusal_of_the_same_finding", ocd:2026-08-05, lmd:2026-08-05] DO NOT re-adjudicate this finding from scratch when the janitor proposes it AGAIN, and do not dispatch its agent on approval, BECAUSE it has now been refused TWICE on the same false premise — TRDD-JJFGDV3W, then TRDD-9COGK66W on 2026-08-05 — and `ticket-dedupe-key: PKGPOL-001:package-manager config` did NOT suppress the second one. A refusal records the verdict; it does not stop the detector. So the cost recurs every time unless someone recognises it, which is exactly what this lesson is for. DO run the ONE command that settles it — `pnpm config get minimumReleaseAge trustPolicy blockExoticSubdeps` — and refuse again if it reports 7200 / no-downgrade / true (it did on 2026-08-05). Note the trap that makes the proposal plausible: its body is mechanically CORRECT (pnpm ignores `package.json#pnpm`) and only its CONCLUSION is wrong, so skimming it reads as sound. Dispatching is worse than wasteful — the proposed fix edits `package.json#pnpm`, which the janitor's own `pkg-manager-guard` hook refuses, pitting a janitor agent against a janitor guard over a non-problem. The dedupe failure belongs upstream in the janitor plugin, never as an edit from here.
[^24]: [id:ATOM-GERK-9WB1, status:valid, supersedes:ATOM-2IIQ-XI6J, desc:"The 'nothing was lost, it is still available over there' clause is a claim about a CONSUMER — grep for one before writing it", keywords:"claimed_the_data_is_still_visible_somewhere removed_a_consumer_and_said_nothing_was_lost nothing_was_lost_claim_unverified detection_still_runs_but_is_surfaced_nowhere", ocd:2026-08-07, lmd:2026-08-07] DO NOT write "the detection still reaches X" when removing the thing that displayed it, BECAUSE that sentence is a claim about a CONSUMER, not about the detector, and it is the single most comforting thing to assert and the least likely to have been checked — here the retired `thrash.unattributed` / `coldStartSessions` had NO consumer outside the file being edited, so removing the advisories left them computed and surfaced nowhere, and the false reassurance was copied verbatim into the code comment, the CHANGELOG, the commit message and this page before a review caught it. DO run the grep for a reader of the field FIRST (`grep -rn "<field>" src/ standalone/ media/ | grep -v <the file you are editing>`), and if it comes back empty, say so: "computed, currently surfaced nowhere — giving it a home is open work." SUPERSEDED BODY: Ratified 2026-08-07 after an audit of what the gate hooks actually injected. Text AgentlensPro puts in front of a MODEL must clear all three: 1. **OWN PROJECT** — scoped to the caller's own cwd. Never another project's session id, path, or agent types. Scoping is exact-cwd and fails QUIET: an unidentifiable caller gets silence, because an unprovable match must not become a claim. 2. **ACTIONABLE NOW** — the caller can change what it is about to do. "Go run investigate_burn later" is a CLI answer, not an interruption. 3. **SIGNIFICANT** — a real anomaly, not the expected cost of normal work. Failing that bar cost two advisories outright (`FAN_OUT_COLD_START`, whose own text ended "No action needed"; `THRASH_UNATTRIBUTED`, about writes provably attributable to nobody) and stripped foreign identities from the denies, the stall messages, and the thrash suspects. Nothing left the PRODUCT — every detection still reaches the dashboard, `--risk`, `investigate_burn` and the skill. **DO NOT** add a hook message because it explains a real finding, BECAUSE each of the removed ones was added exactly that way — to help a HUMAN reading a debug session — and explaining is not interrupting; the reader in production is a busy agent that cannot act on it. **DO** ask the three questions above before adding any hook text, and put anything that fails them behind an explicit request instead.
