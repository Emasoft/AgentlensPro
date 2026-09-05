---
name: agentlenspro-ops-lessons-testing-and-process-hygiene
description: "background agent shows running but does nothing / a fork started acting like the orchestrator / does cache-expired or last-compact cost tokens / is a cache-liveness check free / a free-port probe is flaky in CI but passes on rerun / mocha does not isolate a single test file / a test is flaky under load but fails in isolation too / CI is red while local slices were green / a background pipeline shows no output for 20 minutes and looks hung / recurring maximum call stack size exceeded RangeError / an identity check is green but an address leaked into a github comment / a bare @handle paged a stranger on github / what may a hook say to a model / removed a hook advisory but it still fires / a baseline ruleset restore reverted an owner-approved bypass"
ocd: 2026-07-11
lmd: 2026-09-05
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
---

Background-agent field lessons (they shaped the burn-gate rules):

- **Zombie mode**: a fork can look "running" in the UI while stuck in ONE endless blocking
  shell call — zero API turns, zero effect. Liveness = its transcript file's mtime staying
  fresh, never the task-alive status.[^2]
- **Fork identity anchor**: a fork inherits the parent's full context; after a compaction
  or a mid-life directive it can mistake itself for the orchestrator. Every fork birth
  prompt must carry an identity anchor ("you are X, never orchestrate; if the anchor is
  lost, end") — verified working: an anchored fork correctly refused an orchestration
  directive and handed it to the parent instead of acting.[^3]

^ATOM-K3U3-GHM5 [desc:"The file-scanning identity check cannot see outbound posts — a second guard covers gh", keywords: check-identities_is_green_but_an_address_is_public agent_pasted_an_account_table_into_an_issue email_leaked_in_a_github_comment redact_a_published_comment guard_scans_files_not_posts, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An identity guard that scans FILES cannot see what an agent POSTS. On 2026-08-02 `check-identities` was green while three of the owner's real email addresses sat in three PUBLIC GitHub issue comments (AgentlensPro#8, ai-maestro#95, ai-maestro#102) — agents had pasted `get_account_status --all` and `lifetime-status.sh` tables, whose every row carries an account's email, straight into a comment. The check was not broken and needed no fix: its scope is tracked and shipped files, and a comment is neither. The second enforcement point is `scripts/deny-identity-leak-to-github.js` (PreToolUse on Bash), which scans any `gh` verb that publishes prose — including the body it would read from `--body-file`, the shape all three leaks actually took — and denies on an email or a real-username home path. Verified by replaying the real leaked body through it: denied, all three addresses named masked. [^19] [^20]




^ATOM-N20K-LDOD [desc:"A bare @handle in GitHub prose pages a real user; backtick it, and use mentions: to find real pages", keywords: at-mention_paged_a_stranger_on_github @manager_@janitor_notified_by_mistake how_to_write_a_handle_without_pinging mentions_search_qualifier_vs_text_search, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An `@name` written in GitHub prose PAGES the account with that handle, and the handles agents reach for are already taken by real people. On 2026-08-02 agents writing role names in issue bodies notified two strangers across 9 issues (confirmed with the authoritative `mentions:<user>` search qualifier — NOT with a text search for the handle, whose 932 hits were GitHub tokenising the word and matching every prose use of it). The fix is one character each side: wrapped in backticks the handle renders as code and notifies nobody. The outbound guard `scripts/deny-identity-leak-to-github.js` now denies a bare mention in any `gh` post, stripping fenced and inline code first so the backticked form still passes.




^ATOM-2MG5-ACR9 [desc:"No API reports cache liveness — every freshness verdict is inferred from local evidence; cache-expired and last-compact cost zero tokens (verified 3 ways), but not zero time", keywords: does_cache-expired_cost_tokens is_the_cache_expiry_check_free how_do_I_know_if_the_cache_is_really_alive api_for_cache_liveness cache_verdict_is_inferred_not_measured zero_token_diagnostic, type: project, ocd: 2026-08-04, lmd: 2026-08-04]

There is NO API that reports whether a prompt-cache entry is still alive, so every cache-freshness verdict AgentlensPro gives is an INFERENCE from local evidence (last api_request timestamp vs the session's TTL regime) — by design, not as a shortcut. The only ground truth is to send a request and read cache_read vs cache_creation in the response, and if the cache HAD expired that probe itself pays the full rewrite, so an exact zero-cost answer is impossible in principle. Consequence: agentlenspro cache-expired and last-compact consume ZERO tokens — verified 2026-08-04 three ways: (1) the path is cacheExpiredCli -> callTool -> http://localhost:4316/mcp, and the server side is assessCacheExpiry (pure math) + getTtlContext -> getCurrentAccount -> readFileSync(~/.claude.json); (2) the three api.anthropic.com strings in the CLI bundle belong to OTHER verbs and are unreachable from these paths — /api/oauth/profile and /api/oauth/usage (subscriptionUsage.ts, account metadata) and /v1/messages/count_tokens (exactTokens.ts, ctxmap's exact measurement); (3) neither new module imports either file. Zero tokens does NOT mean zero cost: see TRDD-CXPLAT01 for the 20-40s probe latency measured the same day.




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




^ATOM-LWA9-09CW [desc:"CI red while local slices were green: changing a module's BEHAVIOR contract requires running the suites of its CALLERS, not just the suites of the files you edited (spansScanned flip, ed084ff)", keywords: CI_red_local_green slice_suite_passed_CI_failed forgot_to_run_callers_test_suite contract_test_broke_on_refactor, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

The 9NAUEUUR prefilter changed scanOtelCallEvents' observable contract (spansScanned stopped
counting unparsed spans), and both the worker and the reviewer ran only the suites of the FILES
EDITED (segmentedSpanStore, ndjsonLines) — otelCallEvents.test.ts, which PINNED the old contract,
only ran on CI and went red there. Rule: before claiming green on a behavior change, run the test
suite of every module whose exported function you touched AND of its direct callers (grep the
import); a deliberate contract flip gets the old pin REWRITTEN as a recorded decision, in the same
commit. Landed ed084ff.




^ATOM-KH8H-N8RH [desc:"tail-terminated pipelines look hung when a leaked child holds the pipe; green-on-CI/red-locally means hidden local-state dependency", keywords: background_test_run_empty_output_hang tail_no_output_until_exit pipe_held_open_by_leaked_child green_on_CI_fails_locally timeout_only_on_my_machine, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT read a background pipeline's '20 minutes, empty output' as a hung test run when the pipeline ends in `| tail`: tail withholds EVERYTHING until EOF, and EOF never comes while ANY process keeps the pipe's write end open — a test-spawned child that outlived mocha held it here, so a suite that had finished looked permanently hung and nearly got misdiagnosed as a code regression. DO capture to a file (`cmd > f 2>&1`) and read the file; and when a test is 'green on CI but times out locally', suspect a hidden dependency on local state CI lacks (here: a builder's storeDir defaulting to the developer's real 18-month store).




^ATOM-Y4ZY-Z2V8 [desc:"Spread-into-call RangeError class: recurs across the whole push cycle — sweep the cycle's call graph, not the named file; literal spreads are safe", keywords: maximum_call_stack_size_exceeded_recurred spread_into_call_argument_limit Math.max_spread_large_array summarizeSpans_error_rangeerror fixed_it_but_it_came_back, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT stop hunting a recurring RangeError 'Maximum call stack size exceeded' after fixing the spread sites in the named function's own files, BECAUSE the defect class (spread-into-CALL over an unbounded array — fn(...arr), Math.max(...arr), push(...arr)) recurs anywhere in the same push cycle: after the summarizers were fixed (9da7609) the error came back from computeAnalyticsData's Math.min/max(...times) in standalone/server.ts — same tickBurn→pushUpdate cycle, OUTSIDE the summarizeSpans try/catch. DO walk the ENTIRE call graph of the crashing CYCLE with a plain '\.\.\.'  sweep and review every hit; array-literal spread ([...a]) and object spread ({...o}) are iterator-based and SAFE — only spread into an argument list hits V8's ~125k-arg limit.




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





^ATOM-ZQII-NI24 [desc: "A background subagent that shows running for hours with a tiny, static transcript file is usually BLOCKED inside one long tool call (a cargo test under load), not dead — check its target artifacts' mt", keywords: background_agent_shows_running_but_does_nothing subagent_silent_for_hours transcript_file_not_growing is_my_worker_dead_or_hung should_I_stop_a_silent_subagent cargo_test_blocked_under_load_worker TaskStop_a_running_agent worker_never_answered_SendMessage target_debug_deps_mtime output_file_157_bytes agent_stuck_or_waiting kill_destroyed_a_finishing_run, type: project, trdd: TRDD-MVR6PXC0, ocd: 2026-09-05, lmd: 2026-09-05]
Measured 2026-09-05 (TRDD-MVR6PXC0): a kraken worker sat `running` for 4 h, never answered a SendMessage status ping, its transcript/output file stayed at 157 bytes from 13:50, and its edited `ui.rs` had a 13:12 mtime — every surface an orchestrator checks said "hung". It was not: the worker was inside `cargo test -p agentlens-core` under an afternoon load-avg of 16–164 (an earlier run had been OOM-killed, exit 137), and `rust-core/target/debug/deps` test binaries carried 16:51 mtimes. On this episode the output file stayed static for the whole blocked call — consistent with the harness writing the transcript only at tool-round boundaries (INFERRED, n=1; test it by spawning a worker on a 3-minute `sleep` and watching the file). Stopping it at 17:14 surfaced a complete status (split done, build 0, clippy 0, suite pending) and threw away a run that may have been minutes from green. Rule: before stopping a silent worker, read the mtimes of the artifacts its last step would produce (`ls -lt target/debug/deps | head`, the capture file it writes) and `uptime`; a fresh artifact means WAIT. A SendMessage is only answered at the worker's next tool round, so silence to a ping during a long call proves nothing. If you must stop it, say so on the card as a trade, not as a death.

## See also

- [[memory-scope-leak-detector-false-positives]]

## Governed by

- [[agentlenspro-ops-lessons]] — the operational-doctrine overview this sub-page details.

## Notes and lessons learned

[^2]: [id:ATOM-ZOMBIE-FORK-LIVENESS, status:valid, keywords:"background_agent_shows_running_but_does_nothing zombie_fork_stuck_blocking_call liveness_by_transcript_mtime_not_task_alive", ocd:2026-07-11, lmd:2026-07-11] pinger-v4 incident: the fork collapsed a bounded
  230s tick loop into one unbounded kill-file poll; it sat "running" 4h with its
  transcript untouched. The gate's keep-warm allowance and the liveness-by-mtime rule
  come from this.
[^3]: [id:ATOM-FORK-IDENTITY-ANCHOR, status:valid, keywords:"a_fork_started_acting_like_the_orchestrator fork_mistakes_itself_for_orchestrator compaction_or_mid_life_directive identity_anchor_birth_prompt", ocd:2026-07-11, lmd:2026-07-11] promoted from the old-repo LOCAL note
  `fork-mis-resume-as-orchestrator` (a fork inherited a compaction summary and acted as a
  second orchestrator, spawning a duplicate phase agent). The anchor discipline plus the
  gate's fork rules are the guardrails.
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

[^16]: [id:ATOM-DETECTOR-MATCHED-ITS-OWN-VOCABULARY, status:valid, keywords:"memory-scope-leak flags this page machine-host false positive page about the rule trips the rule detector matched meta-text scope leak proposed", ocd:2026-07-29, lmd:2026-07-29]
  DO NOT go hunting for a leak when `memory-scope-leak` flags THIS page for `machine-host`,
  BECAUSE the only match is the word "hostname" in the scope-routing rule this page QUOTES — a
  page that documents the leak rule necessarily contains the leak rule's vocabulary, so the
  detector matches its own description. DO grep the page for a concrete host/user/path first
  (`<account-nickname>|\.local|MacBook|/Users/<real-name>`) and only act if one is REAL; verified clean
  2026-07-29. Sibling case, already recorded on its own page: the "high-entropy secret" hit on
  [[agentlens-burn-token-model]] is long camelCase identifiers (ATOM-ENTR-IDENT).
[^19]: [id:ATOM-OT53-GHOC, status:valid, desc:"A file-scoped check proves nothing about outbound text; verify each hit before redacting", keywords:"green_identity_check_but_public_leak pasting_an_account_table_into_an_issue bulk_redaction_sweep is_this_hit_a_real_address_or_a_placeholder", ocd:2026-08-02, lmd:2026-08-02] DO NOT paste a tool table into a GitHub issue, PR or comment without redacting it first, and DO NOT conclude "no identities are exposed" from a green `check-identities`, BECAUSE that check scans tracked and shipped FILES only — three real addresses sat in public comments while it reported clean, and a published address cannot be unsent. DO route the account/status views through a redaction pass before posting (the PreToolUse guard now refuses the obvious cases), and when sweeping a repo for leaks, VERIFY each hit before editing: one of the four hits found that day was a synthetic `johndoe` example in someone's documentation, and a bulk redaction would have mangled it for nothing.
[^20]: [id:ATOM-RFW9-SKOO, status:valid, desc:"A text search for a handle counts the word, not the ping", keywords:"searching_for_at-mentions_returns_thousands_of_hits same_count_for_different_handles mentions_qualifier", ocd:2026-08-02, lmd:2026-08-02] DO NOT search for who was paged with a text query like `@manager user:Emasoft`, BECAUSE GitHub tokenises away the `@` and matches the WORD — it returned 932 hits, nearly identical counts for four different handles, which is a signal that means nothing. DO use the `mentions:<user>` qualifier, which is recorded from the actual notification and returned the true answer (5 issues each).
[^24]: [id:ATOM-GERK-9WB1, status:valid, supersedes:ATOM-2IIQ-XI6J, desc:"The 'nothing was lost, it is still available over there' clause is a claim about a CONSUMER — grep for one before writing it", keywords:"claimed_the_data_is_still_visible_somewhere removed_a_consumer_and_said_nothing_was_lost nothing_was_lost_claim_unverified detection_still_runs_but_is_surfaced_nowhere", ocd:2026-08-07, lmd:2026-08-07] DO NOT write "the detection still reaches X" when removing the thing that displayed it, BECAUSE that sentence is a claim about a CONSUMER, not about the detector, and it is the single most comforting thing to assert and the least likely to have been checked — here the retired `thrash.unattributed` / `coldStartSessions` had NO consumer outside the file being edited, so removing the advisories left them computed and surfaced nowhere, and the false reassurance was copied verbatim into the code comment, the CHANGELOG, the commit message and this page before a review caught it. DO run the grep for a reader of the field FIRST (`grep -rn "<field>" src/ standalone/ media/ | grep -v <the file you are editing>`), and if it comes back empty, say so: "computed, currently surfaced nowhere — giving it a home is open work." SUPERSEDED BODY: Ratified 2026-08-07 after an audit of what the gate hooks actually injected. Text AgentlensPro puts in front of a MODEL must clear all three: 1. **OWN PROJECT** — scoped to the caller's own cwd. Never another project's session id, path, or agent types. Scoping is exact-cwd and fails QUIET: an unidentifiable caller gets silence, because an unprovable match must not become a claim. 2. **ACTIONABLE NOW** — the caller can change what it is about to do. "Go run investigate_burn later" is a CLI answer, not an interruption. 3. **SIGNIFICANT** — a real anomaly, not the expected cost of normal work. Failing that bar cost two advisories outright (`FAN_OUT_COLD_START`, whose own text ended "No action needed"; `THRASH_UNATTRIBUTED`, about writes provably attributable to nobody) and stripped foreign identities from the denies, the stall messages, and the thrash suspects. Nothing left the PRODUCT — every detection still reaches the dashboard, `--risk`, `investigate_burn` and the skill. **DO NOT** add a hook message because it explains a real finding, BECAUSE each of the removed ones was added exactly that way — to help a HUMAN reading a debug session — and explaining is not interrupting; the reader in production is a busy agent that cannot act on it. **DO** ask the three questions above before adding any hook text, and put anything that fails them behind an explicit request instead.
