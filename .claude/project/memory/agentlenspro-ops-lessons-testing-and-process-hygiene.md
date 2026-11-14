---
name: agentlenspro-ops-lessons-testing-and-process-hygiene
description: "background agent shows running but does nothing / a fork started acting like the orchestrator / does cache-expired or last-compact cost tokens / is a cache-liveness check free / a free-port probe is flaky in CI but passes on rerun / mocha does not isolate a single test file / a test is flaky under load but fails in isolation too / CI is red while local slices were green / a background pipeline shows no output for 20 minutes and looks hung / recurring maximum call stack size exceeded RangeError / an identity check is green but an address leaked into a github comment / a bare @handle paged a stranger on github / what may a hook say to a model / removed a hook advisory but it still fires / a baseline ruleset restore reverted an owner-approved bypass / a rust parity test fails in one worktree and passes in another with no source change / cargo says the library still returns the old type after the code changed / pnpm run compile-tests aborts with no TTY in a worktree / pnpm tries to reinstall dependencies in a worktree"
ocd: 2026-07-11
lmd: 2026-10-21
metadata:
  node_type: memory
  type: project
  tier: hub
  globs: ["src/test/**", "scripts/deny-identity-leak-to-github.js"]
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
---

# AgentlensPro testing and process hygiene — overview

^YRKGZLDY [desc: "Overview of the testing and process-hygiene hub: field lessons about what flakes, what lies, and what looks broken but is not when running tests and background work on AgentlensPro.", keywords: testing process hygiene overview flaky tests background work looks broken but is not field lessons hub AgentlensPro, lmd: 2026-10-21]
Field lessons about running tests and background work on this repo: what flakes, what lies, what looks broken but is not. This page is the overview; the detail lives in the component pages listed under Applies to. Page-level lessons that no component owns stay below.

^DFQ0LLSR [desc: "Outbound-post guard: a file-scanning identity check cannot see a gh comment, and a bare @handle pages a real account; detail on github-outbound-identity-and-mention-guards.", keywords: identity check green but address leaked github comment bare handle paged stranger outbound post guard file scanning cannot see gh, lmd: 2026-10-21]
- [[github-outbound-identity-and-mention-guards]] — the outbound-post guard: why a file-scanning identity check cannot see a gh comment, and why a bare @handle pages a real account.
^PH3MW3R5 [desc: "The freePort time-of-check-to-time-of-use race, its two mitigations, and why no mocha flag isolates one test file here; detail on test-port-race-and-mocha-isolation.", keywords: free port probe flaky CI passes on rerun freePort TOCTOU race mocha does not isolate single test file mitigations, lmd: 2026-10-21]
- [[test-port-race-and-mocha-isolation]] — the freePort TOCTOU race and its two mitigations, and why no mocha flag isolates one test file here.
^HP29MFDI [desc: "How to diagnose a flaky fixture, CI red while local is green, a hung-looking tail pipeline, and a recurring spread-into-call RangeError; detail on test-flaky-and-ci-red-diagnosis.", keywords: test flaky under load fails in isolation CI red local green slices background pipeline no output looks hung maximum call stack size exceeded RangeError spread, lmd: 2026-10-21]
- [[test-flaky-and-ci-red-diagnosis]] — how to diagnose a flaky fixture, a CI-red/local-green change, a hung-looking tail pipeline, and a recurring spread-into-call RangeError.
^4NL9SRW1 [desc: "The three-question bar every model-facing hook message must clear, and the twin PostToolUse/PreToolUse emitters of each gate code; detail on hook-message-bar-and-gate-emitters.", keywords: what may a hook say to model removed advisory but still fires twin PostToolUse PreToolUse emitters gate code three question bar, lmd: 2026-10-21]
- [[hook-message-bar-and-gate-emitters]] — the three-question bar every model-facing hook message must clear, and the twin PostToolUse/PreToolUse emitters of each gate code.
^P47KUXID [desc: "How to tell a blocked background agent from a dead one via transcript mtime, the fork identity anchor, and why every cache-liveness verdict is inferred; detail on background-agent-and-cache-liveness.", keywords: background agent shows running but does nothing fork acting like orchestrator cache-expired last-compact cost tokens cache liveness check free transcript mtime inferred, lmd: 2026-10-21]
- [[background-agent-and-cache-liveness]] — how to tell a blocked background agent from a dead one (transcript mtime), the fork identity anchor, and why every cache-liveness verdict is inferred.
^CYPKCMBK [desc: "What breaks in a fresh git worktree: shared CARGO_TARGET_DIR, symlinked node_modules with pnpm, and the unit suite run before node esbuild.js; detail on worktree-test-and-build-hazards.", keywords: rust parity test fails in one worktree passes another cargo old type after code changed pnpm compile-tests aborts no TTY reinstall dependencies, lmd: 2026-10-21]
- [[worktree-test-and-build-hazards]] — what breaks in a fresh git worktree: shared CARGO_TARGET_DIR, symlinked node_modules with pnpm, and the unit suite before node esbuild.js.
^WNVEVQE2 [desc: "Related page: memory-scope-leak-detector-false-positives, the lateral see-also for this hub.", keywords: memory scope leak detector false positives lateral see also related page flags PROJECT machine-private data, lmd: 2026-10-21]
- [[memory-scope-leak-detector-false-positives]]
^YFLZM5HU [desc: "This hub is governed by agentlenspro-ops-lessons, the operational-doctrine overview that this sub-page details.", keywords: governed by agentlenspro ops lessons operational doctrine overview sub-page parent aspect testing process hygiene hub, lmd: 2026-10-21]
- [[agentlenspro-ops-lessons]] — the operational-doctrine overview this sub-page details.

## Applies to

- [[github-outbound-identity-and-mention-guards]]
- [[test-port-race-and-mocha-isolation]]
- [[test-flaky-and-ci-red-diagnosis]]
- [[hook-message-bar-and-gate-emitters]]
- [[background-agent-and-cache-liveness]]
- [[worktree-test-and-build-hazards]]

## See also

- [[memory-scope-leak-detector-false-positives]]

## Governed by

- [[agentlenspro-ops-lessons]]

## Notes and lessons learned

[^1]: [id:ATOM-THREE-SQL-ENGINES, status:valid, keywords:"add_preset_wrong_engine pragma_rejected duckdb_preset_in_diagnostics_sql which_sql_engine no_wal_no_database_file", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT add DuckDB-flavored SQL (pragma_database_size, SUMMARIZE, parquet_metadata, a .wal
  check) to `run_diagnostics_sql` presets, BECAUSE that tool runs on the sql.js/SQLite
  forensics SNAPSHOT (src/forensicsSql.ts → forensicsDb.ts; its gate rejects PRAGMA outright)
  — and the DuckDB store is FILELESS (`:memory:` catalog rebuilt from Parquet parts at every
  open: no db file, no WAL, no catalog file to back up). DO route by engine: transcripts →
  `run_transcript_sql` (src/transcriptSql.ts, DuckDB over .jsonl), fact-DB analytics →
  `run_diagnostics_sql` (SQLite), store tuning → the connection SETs in src/store/db.ts.
  (The 2026-07-16 corpus-mining shortlist got items 2+4 wrong on exactly this — TRDD-802FP7ZL.)
[^2]: [id:ATOM-RAW-NUL-BINARY, status:valid, keywords:"grep_returns_nothing_on_source_file file_says_data binary_file_matches nul_byte_in_source separator_byte control_byte_in_source verify_reports_missing_but_code_is_there", ocd:2026-07-16, lmd:2026-07-28]
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
[^3]: [id:ATOM-DETECTOR-MATCHED-ITS-OWN-VOCABULARY, status:valid, keywords:"memory-scope-leak flags this page machine-host false positive page about the rule trips the rule detector matched meta-text scope leak proposed", ocd:2026-07-29, lmd:2026-07-29]
  DO NOT go hunting for a leak when `memory-scope-leak` flags THIS page for `machine-host`,
  BECAUSE the only match is the word "hostname" in the scope-routing rule this page QUOTES — a
  page that documents the leak rule necessarily contains the leak rule's vocabulary, so the
  detector matches its own description. DO grep the page for a concrete host/user/path first
  (`<account-nickname>|\.local|MacBook|/Users/<real-name>`) and only act if one is REAL; verified clean
  2026-07-29. Sibling case, already recorded on its own page: the "high-entropy secret" hit on
  [[agentlens-burn-token-model]] is long camelCase identifiers (ATOM-ENTR-IDENT).
