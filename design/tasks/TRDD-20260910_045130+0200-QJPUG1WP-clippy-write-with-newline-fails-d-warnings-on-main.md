---
trdd-id: QJPUG1WP
title: clippy write_with_newline in rss_guard.rs fails -D warnings on main and the CI rust job
column: human_review
created: 2026-09-10T04:51:30+0200
updated: 2026-11-16T23:00:28+0100
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: medium
severity: low
blocked-by: []
npt: []
eht: []
implementation-commits: [23614488]
project-id: agentlenspro
scope: project
labels: [rust-core, clippy, ci]
related: [WKLD508O, NDKKOABG, 0D6QK5CW]
status: tasked
---

# clippy write_with_newline in rss_guard.rs fails -D warnings on main and the CI rust job

## What was measured (VERIFIED, 2026-09-10 04:46)

`cargo clippy --manifest-path rust-core/Cargo.toml --workspace --all-targets -- -D warnings`
(the exact invocation `.github/workflows/ci.yml:296` runs) exits 101 on the tree at `2d22128a`
plus the uncommitted 0D6QK5CW edits (`rss_guard.rs` untouched by them) with ONE error:
`crates/agentlens-core/src/rss_guard.rs:181` — `write!()` with a format string ending in a single
newline (`clippy::write_with_newline`, rust-clippy 1.97.0 locally). `agentlens-core` (lib and lib
test) then fails to compile under clippy. The CI `rust` job pins the `stable` toolchain
(`ci.yml:271`), so it is INFERRED red on every push until this lands — inferred from that pin and
the local run, not observed on CI. The scoped `-p agentlens-core` form fails identically. The file
was last touched by `97c5123f` (2026-09-08, WIP on TRDD-WKLD508O); it was untouched by the
0D6QK5CW work whose chain surfaced it.

## The fix

`write!(w, "… MB\n")` → `writeln!(w, "… MB")` at `rss_guard.rs:181`, output byte-identical.
Verified: the same `--workspace -D warnings` invocation exits 0 after the edit (04:50). Landed as
`23614488`.

## Acceptance

- [x] `cargo clippy --workspace --all-targets -- -D warnings` exit 0 on the tree with the fix.
- [ ] The CI `rust` job green on the first push carrying the fix (cannot be observed locally; this
      session never pushes).

## Approval log
- 2026-10-16T11:13:20+0200 — column → human_review by main-agent@agentlenspro. fix on main; the open box needs the owner's push and a green CI rust job; row 9


## Owner-stead review

2026-11-16 23:00 — REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): NOT CLOSED, stays in human_review. 1 of 2 boxes is open and needs a green CI rust job. This is an act the main agent does not take: pushing to the remote. Read from the card's own state and acceptance list on 2026-11-16; no test was run for this note.
