# Delegation plan — alcore keeps no resident data model (TRDD-7YPQWKPG)

Gate: **OPEN — 5 units** (threshold ≥3 units / ≥5 files / >30 min — all met). Written 2026-09-06T05:33:47+0200.

Prior ledger (TRDD-465EXTJ6, uncommitted) archived at
`reports_dev/delegation-archive/20260906_053311+0200-DELEGATION-465EXTJ6.md`, not deleted.

Every row is `pending` and `## Evidence` is empty at creation: the four workers were spawned
minutes before this file and none has reported. USER order: urgent, parallel.

Live baseline (pid 78233, after YILE6N3T + 7RM5YW2T + XTFDRTH2): RSS 10.7 GB, physical footprint
2.8 GB, peak 13.2 GB, CPU 58% of a core. Evidence:
`reports/7ypqwkpg/20260906_043059+0200-heap-by-structure-after-xtfdrth2.md`.

| # | Unit | Files (owner) | Worker | Acceptance | Status |
|---|------|---------------|--------|------------|--------|
| 1 | FSMISF5K — session summaries are SQL over the segments; `SpanWindow`, `boot_load`, the rebuild loop are deleted | `rust-core/crates/agentlens-core/src/{span_window.rs,ui.rs,chores.rs,session_summary_sql.rs,lib.rs}` + tests | kraken (fix/fsmisf5k) | `! grep -rqE 'fn boot_load|struct SpanWindow' /Users/emanuelesabetta/Code/AgentlensPro/rust-core/crates/agentlens-core/src/` | pending |
| 2 | Session cards live in a DuckDB FILE under the data dir, bounded buffer pool, not `open_in_memory` | `rust-core/crates/agentlens-core/src/card_store.rs`, its `CardStore::new` call site, `tests/card_store*.rs` | kraken | `! grep -q open_in_memory /Users/emanuelesabetta/Code/AgentlensPro/rust-core/crates/agentlens-core/src/card_store.rs` | pending |
| 3 | mimalloc purges eagerly at startup so freed pages leave RSS (the 8 GB RSS-vs-footprint gap) | the alcore binary's allocator file, its Cargo.toml, one probe example | kraken | `grep -rlqE 'mi_option_set|MIMALLOC_PURGE' /Users/emanuelesabetta/Code/AgentlensPro/rust-core/crates --include='*.rs'` | pending |
| 4 | Cold boot log scan is a DuckDB `read_ndjson_auto` query; Rust holds no per-file JSON trees | `rust-core/crates/agentlens-core/src/log_reader.rs`, new `log_scan_sql.rs` (+ its one `mod` line), tests | kraken | `grep -rl read_ndjson_auto /Users/emanuelesabetta/Code/AgentlensPro/rust-core/crates/agentlens-core/src/ \| grep -q 'log_'` | pending |
| 5 | Integration: review fork per branch, merge all four `--no-ff`, one release build + codesign + restart, re-measure | main branch, `bin-native/darwin-arm64/alcore`, cards 7YPQWKPG/FSMISF5K/+3 | me | `p="$(agentlenspro server status \| sed -n 's/.*pid=\([0-9]*\).*/\1/p')"; [ "$(printf '%s\n' "$p" \| grep -c .)" = 1 ] && ps -o command= -p "$p" > /tmp/alcore-cmd.txt && grep -q 'alcore serve' /tmp/alcore-cmd.txt && /usr/bin/vmmap --summary "$p" \| awk '/Physical footprint \(peak\):/ { seen=1; v=$4; sub(/[GM]$/,"",v); ok=(($4 ~ /G$/ && v+0 < 3) \|\| $4 ~ /M$/) } END { exit !(seen && ok) }'` | pending |

## File ownership

`lib.rs` is shared at the edges: unit 1 owns it, unit 4 may add exactly one `mod log_scan_sql;`
line, unit 2 may change only the `CardStore::new(..)` call. Units 2, 3, 4 never touch
`span_window.rs`, `ui.rs`, `chores.rs`. Unit 3 never touches `agentlens-core/src`. A worker that
needs a file it does not own STOPS and reports; the coordinator resolves it in the merge.

## Review findings applied (fork, 2026-09-06 05:40)

- Rows 1–4 acceptances are symbol checks: a floor, not proof. They gate `done` only. A row moves
  to `verified` on the BEHAVIOUR after deploy: row 1 `spans in memory` = the unflushed buffer;
  row 2 `test -s "$DATA_DIR/cards.duckdb"`; row 3 the probe's printed RSS delta and the live
  RSS-vs-footprint gap; row 4 the isolated-boot peak RSS below the recorded pre-change figure.
- Row 5 asserts the PEAK footprint (the number `boot_load` decides), on the pid the server itself
  reports, not a pidfile.
- Units 1, 2, 4 all edit the boot sequence in `lib.rs` (`restore` at log_reader.rs:720 is read by
  1 and 4). `merge-tree` will call it clean and it will not be. Merge order: 1 first, then rebase
  2 and 4 onto the result one at a time, build after each. Never a three-way.

## Evidence
