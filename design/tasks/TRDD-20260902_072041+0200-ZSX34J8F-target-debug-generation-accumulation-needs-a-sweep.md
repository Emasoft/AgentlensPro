---
trdd-id: ZSX34J8F
title: rust-core target debug accumulates thousands of build generations and nothing ever prunes them
column: backburner
created: 2026-09-02T07:20:41+0200
updated: 2026-10-04T16:37:10+0200
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

## Review findings 2026-10-04

- DEFECT in the rule itself, VERIFIED on rust-core/target/debug/.fingerprint: one crate name has many generations that are live AT THE SAME TIME, one per cargo unit. `libduckdb-sys` has three per build (build-script-build, run-build-script, lib); `agentlens-core` has one per integration test target plus lib and test-lib (14 or more with the same day's mtime). "Keep the newest 2 per crate" therefore removes live units on `--apply`: all but two of agentlens-core's test targets, and for libduckdb-sys possibly the run-build-script output, which is the compiled DuckDB the card wanted to keep. The result is a rebuild, not corruption, but DO NOT run `--apply` with this rule. A correct rule ranks per (crate, unit kind and target name read from the files inside the fingerprint directory), not per crate.
- The process guard matches only a first command word whose basename is exactly `cargo` or `rustc`; it is checked once before the removal loop (a cargo started afterwards is not seen). Accepted as is.
- `CARGO_RETENTION_PS_SNAPSHOT` set in the environment replaces `ps` and so disables the guard in production too; it is documented as a test knob. `--force-while-building` already exists as the explicit override.
- The `--apply` guard `no CACHEDIR.TAG and no <profile>/.fingerprint` can never fire, because the script already exits earlier when `<profile>/.fingerprint` is missing.
- Read and found sound: symlink refusals at every level, `--profile` restricted to one plain path segment, removal paths come only from the one-level listing under the profile directory, every path printed before `rm -rf --`.
- CORRECTION (second review of these findings): "Accepted as is" on the process guard is the agent's reading, not an owner acceptance.
- CORRECTION: "A correct rule ranks per (crate, unit kind and target name)" is an untested proposal, not an established fix. The same listing shows two `lib-libduckdb_sys` generations created in the same minute, so even per-unit ranking has siblings that are live at the same time (different feature sets or dependency hashes).
- CORRECTION: the evidence was a listing of fingerprint DIRECTORY mtimes read by the agent, while the script ranks by the newest FILE mtime; which entries `--apply` would remove was read from the code, not taken from the script's own report mode on the real tree (not run: load average was 146). "The run-build-script output is the compiled DuckDB" is inferred from cargo's layout.
- MISSED by the first read, both from reading the script, neither run: `--keep 0` is accepted and marks every generation removable; the removal loop `cut -f5 | while read -r p` sets no `IFS=`, so a path with leading or trailing blanks would be altered before `rm -rf`.
- OPEN: the script header still advertises `--apply` with no warning; a note on this card is not a guard. Making `--apply` refuse until the rule is corrected is proposed to the owner, not done.
- DO NOT run scripts/cargo-target-retention.sh --apply: the keep-newest-2-per-crate rule removes live cargo units; see the section "Review findings 2026-10-04" at the end of this card.
