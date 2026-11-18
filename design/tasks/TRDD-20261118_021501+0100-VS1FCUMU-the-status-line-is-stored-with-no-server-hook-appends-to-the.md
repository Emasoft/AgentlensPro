---
trdd-id: VS1FCUMU
title: The status line is stored with no server - hook appends to the write-ahead file and alcore statusline-seal compacts
column: dev
status: tasked
created: 2026-11-18T02:15:01+0100
updated: 2026-11-18T02:59:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T02:15:01+0100
implementation-commits: [b78fee7e, e5b4af2e, db19c528]
---

# The status line is stored with no server - hook appends to the write-ahead file and alcore statusline-seal compacts

## Why

Owner, 2026-11-18 (verbatim), answering "accept the loss of status-line samples when no server answers?":

> no, status line hook must be digested at all times. disable must never disable the status line hook. just calling some fast binary to add the data to the duckdb. no need for the full server to be online.

On branch `feat/rbbex59r-c2` (TRDD-RBBEX59R step d3) the status-line hook only POSTs to the server; a sample taken while no server answers is lost. That branch must not land until this card is done. This card is a prerequisite (NPT) of TRDD-RBBEX59R.

## Design (decided by the main agent, reviewed with the advisor, 2026-11-18)

1. The hook POSTs first, as today. When the server did not take the sample (connection refused, error, non-2xx) the hook appends the flattened sample to the store's own write-ahead file `<dataDir>/statusline/<stream>/<UTC day>/wal-cli.ndjson` with one `appendFileSync` (O_APPEND, no child process). Both readers (Rust `relation_for`, TypeScript `relationFor`) already union every `wal-*.ndjson`, so the sample is queryable at once.
2. When the POST is still pending at the render deadline (the server accepted and does not answer), the hook appends the sample locally and returns. The server may store the same sample later, so a duplicate row is possible. Accepted: the stream is already re-sampled many times per turn and the views read per-turn buckets and cumulative deltas.
3. The hook appends; the binary only compacts. New command `alcore statusline-seal --data-dir DIR` runs the existing `maybe_seal` with no server: no port, no pidfile, `nice(15)`. It does NOT run `purge`: retention stays with the server, so a standalone run can never delete a day.
4. Safety lives inside `maybe_seal`, so the server chore and the standalone command are both covered:
   - a cross-process lock `<statusline root>/.seal.lock` (flock, non-blocking): a second sealer returns 0;
   - `wal-<pid>.ndjson` whose pid is the live pidfile owner of the data dir is never touched by another process;
   - `wal-cli.ndjson` is a LIVE file: it is renamed first (`wal-cli.rot-<pid>-<base36><seq>.ndjson`), the sealer waits 150 ms so an appender that opened the old name finishes its one write, then it seals the renamed file;
   - today's `wal-cli.ndjson` is sealed only at `AGENTLENS_STATUSLINE_CLI_SEAL_BYTES` (default 16 MiB), a past day's always;
   - one call starts no new seal after `AGENTLENS_STATUSLINE_SEAL_BUDGET_MS` (default 20,000 ms), so a backlog drains over several calls;
   - `count_lines` streams the file instead of loading it whole (a CLI write-ahead file can be hundreds of MB).
5. The hook starts the sealer detached, only when (a) its append created today's file (the day turned) or the file reached the same byte threshold, (b) no start happened in the last 30 s (stamp `<statusline root>/.seal-kick`), (c) no live server owns the data dir (its 60 s chore seals), (d) `AGENTLENS_NO_REVIVE` is not `1` (the one brake for every detached process a hook starts).
6. The revive after a failed status-line POST is unchanged (it serves the spawn guards).

## Known limits

- A pid reused by an unrelated live process is read as a live owner only when the pidfile names it; a stale pidfile is not verified against the process start time here.
- A duplicate row is possible in case 2.
- With no server for longer than the retention window, old days are not purged until a server runs.
- The sealer is started by the hook only; nothing seals when no status line renders.

## Files (worktree `builds_dev/rbbex59r-c2`, branch `feat/rbbex59r-c2`)

- Rust: `rust-core/crates/agentlens-core/src/statusline_store.rs`, `src/pid_lock.rs`, `src/bin/alcore.rs`, new test `tests/statusline_seal_cli.rs`.
- TypeScript: `src/cli/hookHandlers.ts` (`forwardHookEvent` resolves a boolean), `src/cli/statuslineCapture.ts`, `src/test/statuslineCapture.test.ts`, new test `src/test/statuslineDiskFallback.test.ts`.
- Afterwards: joint leg 10 in `src/test/noCollectionJoint.test.ts`, `docs/operations.md`, `CHANGELOG.md`.

## Checklist

- [x] Rust change + `tests/statusline_seal_cli.rs` green, `statusline_parity` and the `statusline_store` unit tests green, clippy clean
- [x] TypeScript change + `statuslineDiskFallback.test.ts` and `statuslineCapture.test.ts` green, check-types clean
- [x] Joint leg 10: no server, sample on disk, `statusline-history` shows it, `alcore statusline-seal` makes a part
- [ ] Docs: operations.md, CHANGELOG, the header comments of the two source files
- [ ] Sealer proved on a sample of at most 4 GB of the live backlog before the live deploy

## Approval log

- 2026-11-18T02:15:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress 2026-11-18

- Implemented in the worktree, commit b78fee7e on feat/rbbex59r-c2 (not on the main tree, not deployed). Checks, raw output read by the main agent under reports_dev/VS1FCUMU: statusline_seal_cli 8 passed, statusline_parity 3 passed, lib statusline_store 1 passed, clippy -p agentlens-core --all-targets -D warnings clean, check-types rc 0, statuslineDiskFallback 11 passing, statuslineCapture 24 passing. The full suite was not run.
- Three design points were decided AFTER the advisor consult and were not reviewed by it: (a) today's wal-cli.ndjson is sealed at a byte threshold, not at seal_rows (a size test is O(1) on the render path); (b) the file that is off limits is the one of the pidfile owner of the data dir, not of any live pid (statusline_parity.rs uses wal-1.ndjson and pid 1 is always alive); (c) the standalone command never purges.
- Effects on the SERVER's own 60 s seal chore, which runs the same maybe_seal: it now takes .seal.lock, starts no new seal after 20 s per tick, seals wal-cli.ndjson, and counts lines by streaming bytes (a file holding an invalid UTF-8 byte counted 0 before, and a past-day file with that count was removed as empty).
- Late-append loss, found by the harness review and fixed in b78fee7e: a hook process that opened wal-cli.ndjson before the rename can append after the COPY read the file, and the line was then deleted with the file. seal_one now takes the file length at its start and compares it again right before the delete; on a difference it removes the part and keeps the file. Red run without the check: 'sealed 1 WAL' with the late line lost. Test: a_line_appended_after_the_part_was_written_is_not_deleted_with_the_file. STILL OPEN: an append between the check and the delete (two syscalls apart) is not covered. The test uses the knob AGENTLENS_STATUSLINE_SEAL_TEST_HOLD_MS in seal_one.
- Before the statusline-seal dispatch alcore runs install_exit_on_panic, install_open_phase_probe and log_boot_phase. Read whole by the main agent: they set the panic hook and the probe slot and write one line to stderr, nothing under the data dir.
- rustfmt was not applied: the tree has no fmt gate (.github/workflows/ci.yml:297 says it is 3564 hunks away from rustfmt output).
- Correction: the message of commit ca9447ca says 'Card diff read back whole'. At that time only the removed lines, the count of added lines and lines 1-22 of this card had been read. This card was read whole afterwards, on 2026-11-18.
- Doc scope (the checklist line names operations.md): the file is skills/agentlenspro-diagnostics/references/operations.md. A name search also lists CHANGELOG.md, src/cli/cacheExpiredCli.ts and .claude/project/memory/statusline-capture-and-store.md as holding status-line loss wording; their lines are not read yet.
- Commit b78fee7e holds the test knob AGENTLENS_STATUSLINE_SEAL_TEST_HOLD_MS UNGATED in seal_one: any environment that sets it makes every seal wait while it holds the heavy-DuckDB slot and the seal lock. A follow-up commit limits it to debug builds (cfg!(debug_assertions)); the branch must not be merged before that commit.
- Caveats on the lines above. (1) statuslineDiskFallback 11 passing and statuslineCapture 24 passing were run BEFORE the removal of one blank line in statuslineCapture.ts and before the late-append change. (2) The red run shows only 'sealed 1 WAL(s)' at the first failed assertion, that is the sealer sealed a file that had grown; the row count after it was not observed. (3) Source of the count_lines statement: at 1196a88c the function was std::fs::read_to_string(file)...unwrap_or(0), and read_to_string fails on invalid UTF-8. (4) clippy rc 0 and check-types rc 0 were read from the worker report reports_dev/VS1FCUMU/20261118_032000+0100-rust-seal-late-append.md and from the two raw files, after b78fee7e was committed. (5) The late-append test passed 5 of 5 repeat runs by the worker's report; it is timing-based (append during a 3 s hold).
- Not applied, proposal: close the remaining gap by renaming the sealed file to a tombstone that records its sealed length and deleting it on a later call after copying any bytes beyond that length into a new write-ahead file. Judged not worth its extra states now: the gap needs a hook process stalled between its open and its write for longer than the settle wait plus the seal, landing between two adjacent syscalls.
- Follow-up commit e5b4af2e (worktree): the test hold is read only in debug builds (cfg!(debug_assertions)) and the stderr line says 'changed length'. statusline_seal_cli 8 passed (raw output read by the main agent); clippy, check-types, eslint and compile-tests rc 0 by the worker report reports_dev/VS1FCUMU/20261118_040000+0100-seal-corrections-and-leg10-insert.md (their raw outputs hold no warning or error line). No release build was tested for the gate.
- Duplicate rows, WIDER than design point 2 says: the hook appends locally whenever the POST has not settled 50 ms after the render (AGENTLENS_STATUSLINE_RESIDUAL_MS), so a server that is slow but alive can store the sample too, not only one that never answers. Whether the server stores a request whose client has exited was not measured. Reading of the readers: a duplicate is one more render of the same turn, and every reader already sees many renders per turn. Read by the main agent: TypeScript views sessions, peaks and cache (src/cli/statuslineHistoryCli.ts 303-325, 411-428, 462-476): sample count plus one, a zero-delta row, renders plus one; Rust cache_turns turns CTE (cache_turns_sql.rs 323-338): rows with a prompt_id collapse to one, rows without one are already one row per sample (key 'tick:' plus ts). By the worker report reports_dev/VS1FCUMU/20261118_034500+0100-duplicate-rows-and-doc-lines-v2.md: no built-in Rust statement sums raw sample columns; caller-written SQL over the raw statusline relation or SUM(writePct) over turns would count the copy. NOT read: the TypeScript views project, subagents, windows and raw, and cacheExpiredCli.ts (a newest-by-ts pick by the worker's grep).
- Doc lines on the branch that the code now contradicts or leaves incomplete (line numbers on feat/rbbex59r-c2, read by the main agent): CHANGELOG.md 11 ('With the server down a sample is lost') and 15 ('status-line samples are no longer recorded') are FALSE since b78fee7e; CHANGELOG.md 17, README.md 182 and skills/agentlenspro-diagnostics/references/operations.md 90 and 93 are incomplete. By the worker report: .claude/project/memory/statusline-capture-and-store.md 177-179 (samples do not spool). All must be fixed before any merge of the branch.
- Corrections to earlier lines and messages. (1) The message of d5b416bf says the card diff was read whole: it was, and after that read one field (implementation-commits) was set and seen only through grep. (2) Caveat (4) above is wrong on one point: the two raw files hold no rc; the rc values of clippy and check-types come from the worker report, and the raw files show no warning or error line. (3) 'removed as empty' is sourced: at 1196a88c maybe_seal lines 425-427 remove a past-day file whose count is 0. (4) trddgrep validate exits 1 with 333 lines on the whole corpus and none of them names this card.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-18

- WHERE: worktree builds_dev/rbbex59r-c2, branch feat/rbbex59r-c2 at e5b4af2e (b78fee7e feature, e5b4af2e debug-only test hold). Uncommitted there: src/test/noCollectionJoint.test.ts (joint leg 10: inserted, compiled, linted, NEVER RUN). Nothing is on the main tree, deployed or pushed. Snippets: scripts_dev/slseal/ (t11-joint-leg10.ts is leg 10).
- IN FLIGHT at 02:55: a cheap-worker builds the release alcore of the worktree, signs it into builds_dev/rbbex59r-c2/bin-native/darwin-arm64/ (backup alcore.pre-vs1fcumu-20261118), rebuilds the worktree bundle, runs statuslineDiskFallback, statuslineCapture and joint leg 10. Raw output: reports_dev/VS1FCUMU/joint-raw2/ (c3-joint-leg10.txt is the joint run). Its report name ends in -build-and-joint-leg10-run.md.
- NEXT ACTION: (1) read joint-raw2/c3-joint-leg10.txt whole; on '1 passing' commit src/test/noCollectionJoint.test.ts in the worktree by name; on a failure read the assertion and correct the snippet through a worker (leg 10 assumes that 'statusline-history sessions' exits 0 under a DISABLED file and that the day directory holds only wal-cli.ndjson). (2) Docs through a worker, then commit: the lines listed under Progress, plus a CHANGELOG Added entry (text below). (3) Prove the test-data cap applies to worktree cargo runs: cargo test --manifest-path builds_dev/rbbex59r-c2/rust-core/Cargo.toml -p agentlens-spool --test test_data_cap, run from the repository root. (4) Advisor call, then tick the checklist. (5) Merge fix/setup-agent-preflight into the worktree with --no-ff and rerun the gates of TRDD-RBBEX59R. (6) Sealer proof on a sample of at most 4 GB of the live backlog (~/.agentlens/statusline, 6.2 GB, du -sk before any copy), then the deploy steps of TRDD-RBBEX59R.
- DOC TEXT (decided): CHANGELOG 11 replace 'With the server down a sample is lost (it is never spooled), and only the detached revive fires.' by 'With no server answering, the status-line hook appends the sample to the store's own write-ahead file (TRDD-VS1FCUMU, under Added), so the sample is kept; it never enters the hook spool, and the detached revive still fires.' CHANGELOG 15 replace the sentence that starts 'With the server kept down' by 'With the server kept down (agentlenspro server stop --stay-down, or the NO_REVIVE brake), the status-line hook appends every sample to the store's write-ahead file by itself (TRDD-VS1FCUMU, under Added), with or without the kill-switch.' CHANGELOG 17, README 182 and operations.md 90: after 'which stores it' add 'and when no server takes the sample the hook stores it on disk itself'. CHANGELOG Added, new first entry: the status line is stored with no server; path <dataDir>/statusline/<stream>/<UTC day>/wal-cli.ndjson; readers statusline-history, cache-state and cache-expired see it at once; alcore statusline-seal --data-dir DIR compacts with no port, no pidfile, nice 15, no purge; started by the hook at most once per 30 s, never under AGENTLENS_NO_REVIVE=1, never beside a live server; knobs AGENTLENS_STATUSLINE_CLI_SEAL_BYTES (16 MiB) and AGENTLENS_STATUSLINE_SEAL_BUDGET_MS (20 s); a sample can be stored twice when its POST had not settled at the render deadline.
- GOTCHAS: worker prompts state EXPECTED as an rc or a count only, and a ps check needs a bracketed pattern ('[r]bbex59r-c2') or it matches its own shell. A fastedit literal is the whole stripped line. Long doc lines: build the new line in scripts_dev from the old one, then apply it with fastedit --lines N:N --snippet @file and re-read the lines. Never run /janitor-write-handoff here: it sends the transcript to an outside model. The plugin reload of 02:49 (claude-plugins-validation 5.23.1, llm-externalizer 14.6.5) was NOT run and its ack is recorded, so no new marker is expected: the owner types /reload-plugins, or it is run at a moment with no agent in flight.
- UPDATE 03:05, supersedes 'IN FLIGHT' and step (1) of NEXT ACTION above: the worker finished. Worktree is at db19c528 and clean: joint leg 10 ran '1 passing (5s)' against the release alcore built from e5b4af2e (ad-hoc signed, in builds_dev/rbbex59r-c2/bin-native/darwin-arm64/) and the rebuilt worktree bundle; statuslineDiskFallback 11 passing and statuslineCapture 24 passing on the same build; the main-tree bundle is unchanged (ls -l and sha256 compared before and after). Raw output read by the main agent in reports_dev/VS1FCUMU/joint-raw2/. The other joint legs were not rerun. NEXT ACTION now starts at step (2), the docs. No worker is running.
- UPDATE 03:12: a cheap-worker is applying the doc lines in the worktree (CHANGELOG.md 11, 15, 17 and a new Added entry, README.md 182, operations.md 90; new lines prepared in scripts_dev/slseal/docs/) and running the cap proof (agentlens-spool test_data_cap) and check-identities. Raw output: reports_dev/VS1FCUMU/docs-raw/ (c1.diff is the whole doc diff). ON RESUME: read docs-raw/c1.diff whole and the c3 'test result' line, then commit CHANGELOG.md, README.md and skills/agentlenspro-diagnostics/references/operations.md in the worktree by name. Still open after that: the memory page .claude/project/memory/statusline-capture-and-store.md 177-179 (through a memgrep verb, by a worker), the header-comment box is already met by b78fee7e, then steps (4) to (6) of NEXT ACTION.
