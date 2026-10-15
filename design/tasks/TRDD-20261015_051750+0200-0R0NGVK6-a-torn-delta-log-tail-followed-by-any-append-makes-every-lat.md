---
trdd-id: 0R0NGVK6
title: A torn delta-log tail followed by any append makes every later boot fail
column: testing
status: tasked
created: 2026-10-15T05:17:50+0200
updated: 2026-10-15T07:38:00+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T05:17:50+0200
implementation-commits: [3ee0c44c]
---

# A torn delta-log tail followed by any append makes every later boot fail

## Problem
`DeltaLog::read_lines` (rust-core/crates/agentlens-core/src/delta_log.rs:63-83) tolerates ONE torn trailing line and returns Err for a corrupt line anywhere else. `save` and `append_changed` (174-229) append and never check that the file ends with a newline. A process killed mid-append can leave a torn last line (INFERRED: the kernel usually completes an in-flight write(); a tear needs a partial write inside write_all's loop or power loss; TRDD-N6A8VX3G's comment asserts hard kills can leave one). The next start loads fine (torn tail tolerated), but its next append is glued onto the fragment; the glued line is then mid-file and every later `load()` returns Err. The Err propagates out of `DurableState::restore` and `start_sweeper`'s boot channel, and alcore prints the delta-log message ("corrupt line N (not a torn tail …)") and exits 1 (VERIFIED, rust-core/crates/agentlens-core/src/bin/alcore.rs:371, the Err arm of the start_sweeper match at 329). log-offsets is loaded on every start (log_reader.rs 986), so for it every later start fails: only a compaction in the run that glued the line, before it exits, would rewrite the file; once a start has failed at load(), no save runs and only a manual repair recovers it; log-sessions is loaded only on a refused reuse or a version-stale start (log_reader.rs 874), so for it the failure begins at the first such start. body-links is healed by its boot compaction (TRDD-N6A8VX3G); log-offsets and log-sessions are not.

Evidence: VERIFIED by reading the code (main, 2026-10-15); not reproduced; the loud variant has never been observed in the current server.log (see Frequency below); the silent variant prints nothing and cannot be detected from the log. TRDD-6B7VV2Z7 commit 1 adds appends during the startup sweep, where cap kills cluster, so this lands first. Frequency: `grep -ac 'not a torn tail' ~/.agentlens/server.log` = 0 on 2026-10-15 (the current server.log, the only one on disk, which includes 1,517 RSS hard-cap exits) — never observed on this machine. Kept as a release blocker because a single occurrence on log-offsets is a start loop with no automatic exit and the fix is small; the fix is on TRDD-6B7VV2Z7 commit 1's path.

**Silent variant (same family):** `read_lines` (delta_log.rs:64) does `let Ok(raw) = fs::read_to_string(file) else { return Ok(Vec::new()) }`, so ANY read error, not just not-found — including a torn tail that splits a multi-byte UTF-8 character (log-sessions cards carry non-ASCII text) — makes the whole file replay as EMPTY with no error: on a refused reuse the log-sessions delta cards are silently lost; for log-offsets the delta positions are lost (re-reads, cost only) and `written` is seeded short. It persists until a compaction rewrites the file. Fix: not-found ⇒ empty; any other I/O error ⇒ Err (a stated behaviour change: fail loudly instead of degrading silently); split raw bytes on newline and decode per line, tolerating an invalid-UTF-8 or invalid-JSON line only as a torn tail. Both fixes are needed: the heal before append runs after the boot load, which would already have returned the silently-empty delta.
Residual, not fixed here: nothing in DeltaLog is fsynced, so a power loss or kernel panic can still damage a snapshot or delta beyond a torn tail.

## Fix direction
Before any append in `save`/`append_changed`, if the delta file is non-empty and does not end with a newline, truncate it to just after its last newline (0 if none). The dropped fragment is exactly what replay already ignores, so no record is lost; `load()` stays read-only. Test: write records, append a raw torn fragment, append again through the API, assert `load()` succeeds with every complete record. Mutation: remove the heal and `load()` returns Err.

## Acceptance
- [x] heal before append in both append paths
- [x] test plus recorded mutation result
- [x] clippy -D warnings clean and cargo test -p agentlens-core green
- [x] read_lines: not-found ⇒ empty, other I/O error ⇒ Err, per-line UTF-8 decoding with torn-tail tolerance
- [x] tests: torn JSON tail (save and append_changed paths, data under COMPACT_MIN_BYTES), torn UTF-8 tail, corrupt middle line ⇒ Err, delta path is a directory ⇒ Err; mutations recorded

## Approval log

- 2026-10-15T05:17:50+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T07:38:00+0200 — column → testing by main-agent@agentlenspro. fix landed in 3ee0c44c; Rust and TS suites green

## Results

2026-10-15: fixed in 3ee0c44c. Rust: cargo test -p agentlens-core 799 passed / 0 failed (worker-reported, reports_dev/0r0ngvk6-r2-full.txt); clippy -D warnings clean; mutations caught (heal no-op 6 fail, read_to_string-else-empty 3, errors-to-empty 1, always-truncate 1, first-block-only 1). Full cargo test -p agentlens-core 799/0 ran on the round-2 tree; rounds 3-4 changed doc comments and one blank test line only (clippy -D warnings clean and delta_log 12/12 re-run after). Release build OK, no-op rebuild compiled nothing, --version exit 64, sha256 a1f2f64b158be870f93db728ae12ca1f4fb18c186914fb8c3cc3e6a4ca169896 (unchanged at run end); TS unit suite 3177 passing, 0 failing, 13 pending (exit 0, AGENTLENS_ALCORE unset, CLI hot-path latency guard ran and passed). Live collector not redeployed (owner's call).
Residuals (not fixed here): `written` is updated before the write, so a failed heal or append leaves written ahead of disk; nothing is fsynced; a complete record of 16 MiB or more is treated as torn and truncated; on the log-sessions reuse path a dropped torn record stays missing from the snapshot pair until its card changes (the seed_written lag).
Frequency: 0 occurrences of the loud variant in the current server.log (2026-10-15).
