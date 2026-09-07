---
trdd-id: TOIM26HP
title: The session-card DuckDB store is a file under the data dir, not an in-memory database
column: dev
created: 2026-09-06T05:37:50+0200
updated: 2026-09-06T08:10:28+0200
current-owner: kraken-agent-acb4ac9d59a86a1c5
task-type: refactor
parent-trdd: 7YPQWKPG
min-approval-requirement: none
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: [486290c3]
---

# The session-card DuckDB store is a file under the data dir

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06

Implemented on branch `worktree-agent-acb4ac9d59a86a1c5` (`486290c3`), gates green: 621 tests pass
(617 before), `clippy --all-targets -D warnings` clean. `CardStore::new()` is gone;
`CardStore::open(data_dir)` opens `<data_dir>/cards.duckdb` with `memory_limit='256MiB'` and
`threads=2`. The database is **replaced at every boot** — it is a spill file, not a durable store.
The delta-log replay is UNCHANGED (see "Which of the two boot options" below — the answer is the
third one, and the reason it is not the ordered one is a correctness blocker, not a preference).

NEXT ACTION (owner: main): deploy and measure box 4 — the live RSS delta — and settle the two
open questions in "Derived risks", both of which need a post-deploy measurement this branch
cannot take.

## Why

USER ruling on the parent card TRDD-7YPQWKPG: *"duckdb is your memory! the rust code should only
make queries and report the ephemeral answers"*. TRDD-XTFDRTH2 moved the 32,607 session cards out
of a resident `IndexMap<String, Arc<Value>>` and into a DuckDB table — but that table lived in
`Connection::open_in_memory()`, so the corpus was still 100% resident: the win was the shape of the
bytes (JSON text instead of `Value` trees), not their residency. A file-backed database hands the
residency decision to DuckDB's buffer pool, which is what the ruling asks for, and a
`memory_limit` PRAGMA is what makes that decision BOUNDED rather than "whatever DuckDB feels like".

## What changed

- `card_store.rs` — `CardStore::new()` → `CardStore::open(data_dir: &Path)`, opening
  `<data_dir>/cards.duckdb`; `SET memory_limit='256MB'; SET threads=2`. The previous boot's
  database and its `.wal` are removed before the open, and the schema statement is preceded by
  `DROP TABLE IF EXISTS cards` so the corpus starts empty even on a platform where the removal
  could not happen. The `Default` impl is deleted (it only existed to satisfy clippy's
  `new_without_default`, which does not apply to a constructor that takes an argument).
- `lib.rs` — the ONE construction site, inside `CoreState::open(data_dir)`, passes `data_dir`
  through. No other call site exists.
- `tests/card_store.rs` — the 8 `CardStore::new()` call sites go through one `store(name)` helper
  that gives each test its own data dir.
- `tests/card_store_file.rs` — NEW: the file-backed behaviours (the file exists on disk; a
  leftover database from a previous boot is replaced, not reused; two stores over one data dir in
  one process do not interfere).

## Which of the two boot options — NEITHER; the database is replaced at every boot

The task offered "skip the replay for cards already present" or "make the replay idempotent". The
smaller correct change is a third one: **the file is a spill file, replaced at boot**, so the
replay runs exactly as it does today and its idempotency question does not arise. Two blockers,
both verified by reading the code, rule out reusing a previous boot's cards:

1. **CORRECTNESS.** `DurableState::restore` (`log_reader.rs:719-727`) treats a stale
   `LOG_INGEST_VERSION` as *"restore nothing, cold-rescan; stale delta-log entries are tombstoned
   on the next durable save"* — and it does NOT clear the card store, because until now a fresh
   `CoreState` always had an empty one. A cards database that outlives the process would keep
   serving cards built under the OLD ingest semantics forever, and the version stamp — the one
   mechanism that exists to invalidate them — would silently stop working. Wiring that gate into
   the card store's open is a `log_reader.rs` change, which is another worker's file this round.
2. **CONCURRENT INSTANCES.** `tests/log_reader_parity.rs` opens FOUR `CoreState`s over one data dir
   inside a single test (lines 10, 36, 53, 63 of
   `durable_state_round_trips_offsets_and_stripped_cards_and_skips_the_cold_rescan`), with the
   earlier ones still alive. A shared, durable database file would put four live DuckDB writers on
   one file; and line 65 asserts `st4.cards.is_empty()` immediately after making the version stamp
   stale — an assertion that a persistent store fails by construction. Removing the file before
   each open gives every instance its own inode, which is what keeps that shape working.

If durable reuse is wanted later (it would remove the boot replay's peak entirely, which is this
card's parent's actual target), it is a follow-up that must wire the `LOG_INGEST_VERSION` gate into
`CardStore::open` and settle the four-writers shape — not a change that can be made from inside
`card_store.rs` alone.

## Derived risks — both need a post-deploy measurement

- **DEVICE WRITES.** `agentlens-store/src/lib.rs:4` carries a MEASURED project doctrine: *"NEVER a
  persistent .duckdb file — DuckDB rewrites row-groups in place and a persistent db burned 300x the
  device writes."* That was measured on the body store (a ~21 MB/min append pipeline), and the card
  store's write rate is orders of magnitude lower — but it is the same mechanism, and the machine's
  budget is 15 GB/day (`.claude/project/memory/ssd-write-economics.md`). Main should measure the
  daily device writes attributable to `cards.duckdb` alongside the RSS delta. The lever if it is
  too high is `checkpoint_threshold`, or reverting to `open_in_memory()` + `temp_directory` (see
  the next risk's note).
- **SORT SPILL ON THE HOT READ.** `cards_json()` is `SELECT card FROM cards ORDER BY seq` and runs
  on every summary rebuild; the sort carries the whole card text as payload. If the corpus text
  exceeds the 256 MB limit that sort spills to `<data_dir>/cards.duckdb.tmp` on EVERY rebuild —
  latency on the hot path plus device writes. Check `du -sh` of the file post-deploy against the
  limit; the constant is one line (`MEMORY_LIMIT` in `card_store.rs`), and `statusline_store.rs`
  already uses 2GB for its connection.
- **THE STATE LOCK NOW COVERS A DISK WRITE.** `put` stays autocommit for the incremental ingest
  path, and it runs inside `put_log_session` under the state lock — so every card a log sweep
  produces now costs a WAL append (and its fsync) while the lock is held. TRDD-O3ICDRLO and
  TRDD-XX1UAZHS are both about lock-hold time, so this belongs in the same measurement: the boot
  replay is already wrapped in ONE transaction and is not affected, but steady-state ingest is.
  Expected to be sub-millisecond per card against the seconds-scale holds those cards chase — a
  prediction, not a measurement.
- **`cards.duckdb` is invisible to the disk-usage reporting.** Every data-dir scanner in
  `server_stats.rs` filters by suffix (`.ndjsonl`, `bodies-*.wad`, `*.request.json`), so nothing
  deletes the new file — and nothing counts it either. Worth adding to the stats if the file turns
  out to be large; that is a `server_stats.rs` change.
- **UNMEASURED ALTERNATIVE.** `open_in_memory()` + `memory_limit` + a `temp_directory` under the
  data dir would bound RAM with far fewer device writes IF DuckDB's buffer manager evicts an
  in-memory database's base-table blocks to the temp directory. That is unverified here, and the
  failure mode if it does not is severe (inserts fail with an out-of-memory error once the corpus
  passes the limit — the server would start losing cards), which is why the ordered file-backed
  shape was implemented instead. Settling it is one measurement, not an opinion.

## Acceptance

- [x] 1. `open_in_memory` is gone from `card_store.rs`; the path is `<data_dir>/cards.duckdb`,
      recorded in the `CARD_DB_FILE` constant and asserted by `tests/card_store_file.rs`.
- [x] 2. A boot that finds an existing database replaces it and replays from the delta log
      unchanged — asserted by `a_database_left_by_a_previous_boot_is_replaced_not_reused`. The
      replay itself is untouched (and is upsert-idempotent regardless, via `ON CONFLICT DO UPDATE`).
- [x] 3. `cargo clippy -p agentlens-core --all-targets -- -D warnings` clean and
      `cargo test -p agentlens-core` green; no wire shape changed (no read path, no SQL, and no
      serialization was touched).
- [ ] 4. Live RSS delta after deploy — LEFT FOR MAIN (this branch does not deploy).

## Approval log

- 2026-09-06T05:37:50+0200 — Tier 0 (`min-approval-requirement: none`): a derived refactor of one
  module inside the parent card's approved scope, authored directly in `design/tasks/`.
