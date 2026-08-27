---
trdd-id: NDKKOABG
title: rust-core was never built or tested by CI — add the job, with caching
column: dev
created: 2026-08-27T22:45:45+0200
updated: 2026-08-27T22:45:45+0200
current-owner: main-session
task-type: infra
scope: project
project-id: agentlenspro
parent-trdd: DMWOBWFH
min-approval-requirement: none
relevant-rules: []
implementation-commits: []
---

# rust-core was never built or tested by CI — add the job, with caching

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-27

- **Trigger.** The USER approved *"the caching on github workflows is also good"*. Looking for
  where to put a Rust cache surfaced the larger fact: **`ci.yml` has no Rust job at all.**
  `rust-core/` is compiled ONLY by `publish.yml`'s `build-platform-packages` matrix, i.e. only on
  a release tag — so a broken crate merges to `main` green and first fails during a release.
- **Done.** `ci.yml` gained a `rust` job: pinned `dtolnay/rust-toolchain` (the SAME SHA
  `publish.yml` already uses), `Swatinem/rust-cache@6323deb` (v2.9.2, `workspaces: rust-core`),
  then `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`.
- **Getting to green required 16 source fixes** (details below) — the job was red on arrival,
  which is itself the evidence that the gate was missing. Both gates now pass on a clean tree:
  clippy exit 0, and `cargo test --workspace` **582 passed / 0 failed / exit 0**.
- **NEXT ACTION.** Commit, then let CI's first run on the branch prove the cold-cache path fits
  inside `timeout-minutes: 40`.

## What was wrong, and what changed

### 1. The missing gate

`ci.yml` had exactly two jobs — `build-and-test` (TS) and `browser-smoke`. No `cargo` anywhere.

### 2. 15 clippy findings, all pre-existing

`cargo clippy --workspace --all-targets -- -D warnings` was **red on a clean tree**. Fixed:

| Where | Lint | Fix |
| --- | --- | --- |
| `agentlens-ingest/src/lib.rs` | `items_after_test_module` | moved `process_metrics` above `mod tests` |
| `agentlens-store/src/pass.rs` ×4 | doc list indentation | 5-space continuations + a paragraph break |
| `agentlens-core/src/log_reader.rs` ×4 | doc lazy continuation | blank `//!` before the DEFERRED paragraph |
| `agentlens-core/src/ui.rs` | doc lazy continuation | same |
| `agentlens-core/src/summarize/helpers.rs` | `needless_range_loop` | `first.iter().enumerate()` |
| `agentlens-core/src/summarize/helpers.rs` | `filter().next_back()` | `rfind()` |
| `agentlens-core/src/summarize/loop_detector.rs` ×2 | `sort_by` → `sort_by_key` | `cmp::Reverse` |
| `agentlens-core/tests/span_window.rs` | `assertions_on_constants` | `const { assert!(..) }` |
| `agentlens-core/tests/ui.rs` | `while_let_loop` | `while let Some(..)` |
| `agentlens-core/tests/log_reader_parity.rs` | `Iterator::last` on a DEI | `next_back()` |

Three were **suppressed deliberately**, each with the reason in a comment at the site:

- `feed_merge.rs` `neg_cmp_op_on_partial_ord` — `!(x > 0.0)` is **not** `x <= 0.0`: the negated
  form is TRUE for NaN, which is the TS `!(t > 0)` this ports. "Simplifying" it silently changes
  which feed wins on a NaN token count.
- `log_reader.rs` `large_enum_variant` — at most `ACCUM_CACHE_MAX` (24) live at once; boxing buys
  ~1 KB of stack for 24 allocations and an indirection on the per-line parse path.
- `pricing.rs` `too_many_arguments` (8/7) — the signature is argument-for-argument the TS
  `calcTokenCostUsd` and the two are diffed whenever a rate changes.

### 3. A test fixture git can never carry — the find that justifies the job

`cbreport_parity.rs` asserts `coverage.dirExists == true` against
`tests/fixtures/cbreport/empty-spool`, **an empty directory**. Git cannot track an empty
directory, so on any fresh clone — every CI run, every new contributor — the dir is absent and
the assertion takes the opposite branch. It failed locally the moment the workspace was run as a
whole. Fixed by creating it on demand in the test (`empty_spool()`), which needs no tracked file
and leaves `git status` clean.

## Load-bearing facts

- **`cargo test --workspace` is CORRECT, and the "-p agentlens-store only" habit was about
  COST, not correctness.** The local slowness has a measured cause that does not apply to CI:
  on macOS each freshly-built test binary pays a one-off ~70 s launch stall (0% CPU, `S` state,
  no open files) before the harness prints `running N tests` — with ~100 test binaries that is
  the bulk of a 30-minute local run. Standalone, the same binary finished in **0.04 s**. Linux
  runners have no such per-binary stall, so `timeout-minutes: 40` is generous.
- **Caching belongs in CI and stays out of `publish.yml` — deliberately.** A poisoned cache in
  the release path would be baked into a published artifact; in CI it only skews a signal. This
  keeps the existing zizmor/`cache-poisoning` note in `publish.yml` intact rather than
  contradicting it.
- **No `cargo fmt --check` step, on purpose.** The tree is **3564 hunks across 200 files** from
  rustfmt's output. Adding the gate today means a mechanical reformat that buries every real
  Rust diff for the whole port. It belongs as the FIRST commit of the cutover, not as a side
  effect of wiring CI.
- `publish.yml`'s `cargo build --release` (line ~208) is still uncached across 4 native runners.
  Left alone for the reason above; the cost is real and is the USER's call to re-decide.

## Verify

```bash
cargo clippy --manifest-path rust-core/Cargo.toml --workspace --all-targets -- -D warnings  # exit 0
cargo test  --manifest-path rust-core/Cargo.toml --workspace                                # exit 0
python3 -c "import yaml; print(list(yaml.safe_load(open('.github/workflows/ci.yml'))['jobs']))"
```

## Approval log

- 2026-08-27T22:45:45+0200 — Tier 0 (`min-approval-requirement: none`): a CI-only workflow
  addition plus lint fixes inside this project's own tree. The `.github/` touch would normally
  floor at MANAGER, but the USER approved workflow caching directly in this thread; no baseline
  ruleset, permission, or release behaviour changes.
