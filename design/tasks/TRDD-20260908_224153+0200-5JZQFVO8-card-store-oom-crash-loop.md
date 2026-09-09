---
trdd-id: 5JZQFVO8
title: The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert
column: dev
created: 2026-09-08T22:41:53+0200
updated: 2026-09-09T12:15:41+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: critical
blocked-by: []
parent-trdd: 7YPQWKPG
npt: []
eht: []
implementation-commits: [86acd104]
project-id: agentlenspro
scope: project
labels: [rust, duckdb, card-store, boot, crash-loop, memory]
relevant-rules: []
---

# The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-09 12:15

Fix LANDED in `86acd104`: `rust-core/crates/agentlens-core/src/log_reader.rs` ~:729-763:
`RESTORE_CHUNK = 2_000`, commit+begin every 2,000 cards (comment cites `card_store.rs` `open`
recreating the file and the state lock at `log_reader.rs:1007` (was :996 before the +11-line
diff)). Test added:
`a_restore_sized_bulk_load_stays_inside_the_memory_limit` in `tests/card_store.rs` (N=60_000,
≈1.7× the real corpus, 12 whale rows of 310 KB; 80k ran 493 s, 60k ran 510 s under heavier
load — a 🐌 test).

Reviewed 2026-09-08 (accepted with amendments) and 2026-09-09:
- begin/commit are plain BEGIN/COMMIT (`card_store.rs:142-148`); nothing in the loop spans the
  chunk boundary.
- whether COMMIT also checkpoints the ART index charge is DuckDB's auto-checkpoint —
  INFERRED, not verified; the real-corpus boot is the discriminator.
- `demote_cold_timelines`, which runs right after the restore, is the same unbounded shape and
  is UNMEASURED — next suspect if the boot still dies one line later.

Evidence landed 2026-09-09 (reports under `reports/trdd-5jzqfvo8/`): the single-transaction
mutant FAILS the test at `card_store.rs:168` with DuckDB's Out of Memory Error (255.9/256.0
MiB), exit 101; `target/release/alcore` rebuilt 11:39:51 with the fix; boot #2 on a copy of
snapshot+delta+`log-delta-version.json`: `restored 35258 session cards`, no panic, no
`cold-rescanning`, alive +126 s, footprint 608 MB (peak 894 MB), restore lock 14,738 ms. NOT
established: resident footprint with the real 4.38M-span store and the live transcript scan (no
spans dir, tmp HOME), and `demote_cold_timelines` on a store that also holds span-derived cards.

Real collector: 138 OOM panics logged, last revive 2026-09-08 23:47 died 23:48;
`server.pid` still names dead pid 17041.

Deploy sequence (USER go required; the owner must also decide TRDD-81BW1CS9 first: recover pid
68584's diverted capture BEFORE the kill, or abandon-for-now — its tmp dir stays on disk, never
deleted):
1. `ls -ld $(readlink -f $(which agentlenspro))` must be this repo's `standalone/cli.js`
   (verified 12:01).
2. Record `shasum -a 256 rust-core/target/release/alcore` here (`bin-native/` is gitignored, so
   the deployed binary has no commit link otherwise).
3. `cp rust-core/target/release/alcore bin-native/darwin-arm64/alcore.new` →
   `codesign -s - --force bin-native/darwin-arm64/alcore.new` →
   `mv bin-native/darwin-arm64/alcore.new bin-native/darwin-arm64/alcore` (same dir = rename(2),
   atomic; never `cp` over the mapped binary — the exit-137 shape).
4. `./bin-native/darwin-arm64/alcore --version` must exit 0 (137 = the codesign shape) BEFORE
   touching 68584.
5. `kill -TERM 68584`, then poll `kill -0 68584` until it is gone.
6. `agentlenspro server restart`. A hook-revive may win the race on 3000 with the fixed binary
   and the real data dir; then the restart's own 'exited during startup' line is NOT
   authoritative — read `started-by=` in `~/.agentlens/server.log`.
7. Judge the boot from `server.log`: `RSS HARD CAP` (the WKLD508O guard at 2 GB, ruled
   behaviour) vs `Out of Memory` (the old loop); confirm `logSessions` ≈ 35k and the footprint.

NEXT ACTION: the deploy above, on the owner's word. DELEGATION.md row 4 is verified (cargo test
card_store: 11 passed, exit 0, 188.79 s).

## Why

On the real `~/.agentlens` store (4,382,419 spans / 31 segments, ~33k session cards) every
hook-revive boot dies within ~6–20 s because the card store's DuckDB connection pool
(`memory_limit='256MB'`, `threads=2`, `card_store.rs` ~81-131) runs out of memory while
upserting session cards during the boot sweep. This is a crash LOOP, not a one-off: each
hook invocation revives the server, the server OOMs during its boot sweep, and the process
exits — repeating on every subsequent hook fire.

## Evidence

- Panic: `thread 'log-sweeper' panicked at crates/agentlens-core/src/card_store.rs:168:14:
  upsert a session card: DuckDBFailure(... "Out of Memory Error: could not allocate block of
  size 256.0 KiB (255.8 MiB/256.0 MiB used)")`, followed by `alcore: log-sweeper died during
  the boot sweep`, then process exit.
- 1,155 hook-revive boots logged in `~/.agentlens/server.log` today; first OOM at log line
  538148.
- Card store pool config: `SET memory_limit='256MB'; SET threads=2` (`card_store.rs` ~81-131).
- Deployed binary: `bin-native/darwin-arm64/alcore` from the 2026-09-07 22:21 deploy (commit
  482f38d6).
- The crash loop was MASKED until 22:38 because a leaked test server (see TRDD-YGEV6QDD) was
  squatting the canonical ports, so hook fires were routed to it instead of triggering a real
  revive-and-crash cycle.
- A background investigator is writing a root-cause report under `reports/card-store-oom/`
  (path only — content not yet available at card-authoring time).
- Related open cards: TOIM26HP, DKBGT7MQ, FSMISF5K, WKLD508O.

## Acceptance

- [ ] Root-cause report read from `reports/card-store-oom/`.
- [ ] A minimal fix proposed (bounded batch/commit sizing in the boot sweep, or a spilling
      DuckDB config) — NOT a raised `memory_limit`.
- [ ] Fix passes adversarial review (per `~/.claude/rules/propose-then-review-then-implement.md`)
      before implementation.
- [ ] A hook-revive boot against the real `~/.agentlens` store completes the boot sweep without
      an OOM panic.
- [ ] `cargo test --workspace` (excluding known-hanging `tldr coupling` per project memory)
      passes on the affected crate.

## Approval log

