---
trdd-id: ZSX34J8F
title: rust-core target debug accumulates thousands of build generations and nothing ever prunes them
column: backburner
created: 2026-09-02T07:20:41+0200
updated: 2026-10-04T15:47:46+0200
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
2026-10-04: retention rule STATED — keep the newest 2 generations per crate (newest = mtime of .fingerprint/<crate>-<hash>), older ones removable. scripts/cargo-target-retention.sh reports by default (one find+du pass, grouped in awk; 600-entry synthetic tree in about 1 s) and removes only with --apply (refused unless the path ends in /target and holds CACHEDIR.TAG or debug/.fingerprint; symlinks never followed; every path printed first); --apply tested on synthetic trees only. Measured on rust-core/target (totals only): du -sk target 53,656,372 KiB; du -sk target/debug 37,465,116 KiB; 1,838 .fingerprint entries. The per-crate generation breakdown on the real target was NOT completed (the first per-entry version was too slow and was stopped). Applying the rule to the real target is the owner's decision; acceptance (before/after numbers) is still owed.
