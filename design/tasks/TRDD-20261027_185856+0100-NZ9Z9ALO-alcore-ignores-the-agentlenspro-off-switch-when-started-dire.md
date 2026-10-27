---
trdd-id: NZ9Z9ALO
title: alcore ignores the AgentlensPro off switch when started directly
column: ai_review
status: tasked
created: 2026-10-27T18:58:56+0100
updated: 2026-10-27T20:28:17+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T18:58:56+0100
implementation-commits: [97752fb1, dc3f4da0]
---

# alcore ignores the AgentlensPro off switch when started directly

Premise verified 2026-10-27. The CLI honours the AgentlensPro off switch: src/cli/serverControl.ts line 297 refuses to start the server while the DISABLED switch file (~/.agentlens/DISABLED) exists. alcore itself never reads that file. Command run: grep -rn DISABLED rust-core/crates/agentlens-core/src. It returns 5 lines and none of them tests for the file: lib.rs:317 (a doc comment on the embed feature), cache_break_timeline.rs:185 and :1068 (CACHING_DISABLED), bin/alcore.rs:225 (a comment) and spool_tap.rs:482 (a log line). A case-insensitive grep returns 27 lines, none of which tests for a file named DISABLED. The comment at bin/alcore.rs:225 says the omission is deliberate: NO_REVIVE only, never the global DISABLED switch, because DISABLED is terminal and is handled by the CLI gate. The comment shows alcore leaves DISABLED to the CLI gate; whether a directly started alcore ignoring it was a considered decision is not established. A second, separate problem: the comment at src/cli/serverControl.ts lines 927 to 930 says that under DISABLED the spawn must proceed so the child refuses with EX_CONFIG 78. alcore only exits 78 for the embed-key refusal at bin/alcore.rs:305 (grep for exit(78) across rust-core/crates), so a supervisor that spawned alcore under DISABLED would get a live server. Whether that spawn is reachable under DISABLED is not traced here. Why it matters: an alcore started directly (a test harness, a stale LaunchAgent, a manual run) runs and ingests while the owner believes AgentlensPro is off. Open question for design: should alcore refuse to start, or start read-only, when the DISABLED switch is present? If it refuses, the clone harness must then pass an explicit override. Source: docs_dev/20261027_190000+0100-735Q3JF4-inc1-acceptance-rerun-report.md (premise corrections).

## Approval log

- 2026-10-27T18:58:56+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-27T19:58:01+0100 — column → ai_review. fix committed 97752fb1 + dc3f4da0, reviewed; full suites not yet run

## Fix 2026-10-27

- Fixed in 97752fb1: alcore main refuses to boot with exit 78 (EX_CONFIG) when <data_dir>/DISABLED exists, checked before any file, lock, key or listener; ported from the retired TS server gate (standalone/server.ts before 567fc5c2, lines 107-119). This also makes the supervisor's terminal-exit path (serverControl.ts isTerminalExit) work again under DISABLED. Design question answered: refuse, not read-only, matching the old server.
- Test rust-core/crates/agentlens-core/tests/disabled_refuses_boot.rs: exit exactly 78, stderr names the flag, no pidfile, spans dir or embed-key created. Mutations: gate disabled fails it by the 10 s timeout; gate moved below the pid lock claim fails it on 'no pid lock may be taken before the gate'. dc3f4da0 adds a Drop guard so the temp dir is removed on every exit path. clippy -D warnings clean; exit_on_panic passes.
- Known gaps, deliberate: (1) the AGENTLENS_DISABLED=1 environment variable is not read, like the old server, because --force-install-telemetry overrides the env half only in-process and its children inherit the variable (src/cli/killSwitch.ts:118-122); (2) new boots only: a running server is stopped by `agentlenspro disable` (disableCli.ts stopServer), not by this gate; (3) launchd behaviour is unchanged by this fix: the LaunchAgent runs the TS supervisor, which refuses under DISABLED; with KeepAlive true launchd relaunches it about every 10 s, a pre-existing refusal loop this fix neither causes nor cures.
- Consequence for clone harnesses: a copy of the live data dir carries DISABLED (and DISABLED-KEEP-STATUSLINE), so any run with a binary at or after 97752fb1 must remove them from its own copy; scripts_dev/735q3jf4-repeat/run.sh (a local dev harness, not in the repo) now does, and aborts if alcore is not alive after readiness. The harness strips the flag from its own copy instead of the explicit override the original body suggested.
- Full suites run 2026-10-27 at 317c873e (load below 30): cargo test -p agentlens-core 937 passed, 4 failed; TS unit suite 3256 passed, 0 failed. The 4 cargo failures are pre-existing and unrelated to DISABLED: core_cap_guard::no_literal_duckdb_threads_outside_the_allowlist, and three 1h-backfill tests (restore_backfill_fills_the_correct_deduplicated_value_and_touches_nothing_else, run_1h_backfill_step_persists_before_returning_so_a_hard_exit_loses_nothing, run_1h_backfill_step_does_not_scan_the_whole_card_store). Evidence: docs_dev/20261027_202639+0100-NZ9Z9ALO-full-suites-report.md (local, gitignored). No CI job was checked for a fixture data dir holding DISABLED.
