---
trdd-id: QJPUG1WP
title: clippy write_with_newline in rss_guard.rs fails -D warnings on main and the CI rust job
column: testing
created: 2026-09-10T04:51:30+0200
updated: 2026-09-10T04:51:30+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: medium
severity: low
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [rust-core, clippy, ci]
related: [WKLD508O, NDKKOABG, 0D6QK5CW]
---

# clippy write_with_newline in rss_guard.rs fails -D warnings on main and the CI rust job

## What was measured (VERIFIED, 2026-09-10 04:46)

`cargo clippy --manifest-path rust-core/Cargo.toml --workspace --all-targets -- -D warnings`
(the exact invocation `.github/workflows/ci.yml:296` runs) exits 101 on `main` at `2d22128a`
with ONE error: `crates/agentlens-core/src/rss_guard.rs:181` — `write!()` with a format string
ending in a single newline (`clippy::write_with_newline`, rust-clippy 1.97.0). `agentlens-core`
(lib and lib test) then fails to compile under clippy, so the CI `rust` job is red on every push
until this lands. The scoped `-p agentlens-core` form fails identically. The file was last touched
by `97c5123f` (2026-09-08, WIP on TRDD-WKLD508O); it was untouched by the 0D6QK5CW work whose
chain surfaced it.

## The fix

`write!(w, "… MB\n")` → `writeln!(w, "… MB")` at `rss_guard.rs:181`, output byte-identical.
Verified: the same `--workspace -D warnings` invocation exits 0 after the edit (04:50).

## Acceptance

- [x] `cargo clippy --workspace --all-targets -- -D warnings` exit 0 on the tree with the fix.
- [ ] The CI `rust` job green on the first push carrying the fix (cannot be observed locally; this
      session never pushes).

## Approval log

