---
trdd-id: ZSX34J8F
title: rust-core target debug accumulates thousands of build generations and nothing ever prunes them
column: backburner
created: 2026-09-02T07:20:41+0200
updated: 2026-09-02T07:20:41+0200
current-owner: agentlenspro-15
task-type: infra
project-id: agentlenspro
created-by: 2C23ROPZ
external-refs: [https://github.com/Emasoft/AgentlensPro/issues/18]
---

# `target/debug` accumulates build generations — the +30.8 GB is the COUNT, not the size

EHT of [[TRDD-2C23ROPZ]], which bounded what ONE generation writes (DuckDB's C++ output 3.10 GB →
0.47 GB per full rebuild). Measured while doing so (2026-09-02, `rust-core/target/debug`, 92.4 GB):

- `.fingerprint` generations per crate: **agentlens-core 2,997**, agentlens-store 140, spanstore 85,
  logscan 73, ingest 70, libduckdb-sys 18. Every distinct rustc-flags / feature / profile / target
  hash leaves its own `deps/*-<hash>`, `incremental/<crate>-<hash>/` and `.fingerprint/` entries,
  and cargo never removes a superseded one.
- `build/libduckdb-sys-*`: four complete ~3.1 GB C++ output dirs side by side.
- A touch cycle rewrites ~94–101 MB; a full rebuild ~1.5 GB (bounded profile). Neither reaches
  30.8 GB in 3 days — thousands of retained generations do.

## What to decide

The lever is a bounded COUNT, not a smaller generation. Candidates, to measure before adopting:
- `cargo sweep --time N` / `--installed` on a schedule (removes artifacts older than N days or not
  produced by the installed toolchain) — a periodic LaunchAgent step or a git hook.
- A `CARGO_TARGET_DIR` per purpose (test vs clippy vs rust-analyzer's `flycheck0`) so check-mode
  generations stop interleaving with build-mode ones in one tree.
- `cargo clean -p <crate>` of the workspace crates only, keeping the expensive DuckDB generation.

Acceptance: a stated retention rule, applied, with `du -sk target/debug` and the generation counts
before/after recorded here; the live `alcore` binary (`target/release`) untouched; nothing runs while
a cargo job owns the tree (a sweep mid-build corrupts the build).

## Notes and lessons learned
