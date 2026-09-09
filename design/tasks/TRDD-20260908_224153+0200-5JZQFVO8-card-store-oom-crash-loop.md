---
trdd-id: 5JZQFVO8
title: The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert
column: dev
created: 2026-09-08T22:41:53+0200
updated: 2026-09-09T11:36:35+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: critical
blocked-by: []
parent-trdd: 7YPQWKPG
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [rust, duckdb, card-store, boot, crash-loop, memory]
relevant-rules: []
---

# The collector crash-loops at boot because the card store 256 MB DuckDB pool overflows during the boot sweep upsert

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-09 11:36

Fix ON DISK, uncommitted, in `rust-core/crates/agentlens-core/src/log_reader.rs` ~:729-763:
`RESTORE_CHUNK = 2_000`, commit+begin every 2,000 cards (comment cites `card_store.rs` `open`
recreating the file and the state lock at `log_reader.rs:996`). Test added:
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

Evidence still missing as of 11:35:
- the mutation check (the single-transaction pre-fix code must FAIL the new test; a timeout
  result is undetermined, not a pass).
- the release rebuild — `target/release/alcore` is still the 22:43 build, predates the fix.
- the isolated boot on a COPY of snapshot+delta measures the RESTORE only (no spans dir
  copied), so it says nothing about resident footprint against the real 4.38M-span store.

Real collector: 138 OOM panics logged, last revive 2026-09-08 23:47 died 23:48;
`server.pid` still names dead pid 17041.

Deploy sequence once PASS (USER go required): `cp` to a temp name in
`bin-native/darwin-arm64` → `codesign -s - --force` → atomic `mv` over `alcore` (never `cp`
over the running mapped binary — the exit-137 shape) → `kill -TERM 68584` (only AFTER its
diverted data is recovered per TRDD-81BW1CS9) → `agentlenspro server restart` (verify
`agentlenspro` resolves to this repo first) → read `~/.agentlens/server.log` for `RSS HARD
CAP` before calling a 6-second exit an OOM — the new binary carries the fixed WKLD508O guard
and a 2 GB exit is the ruled behaviour.

NEXT ACTION: read the worker report under `reports/trdd-5jzqfvo8/`, then commit
`log_reader.rs` + `tests/card_store.rs` by name, then the deploy on the owner's word.

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

