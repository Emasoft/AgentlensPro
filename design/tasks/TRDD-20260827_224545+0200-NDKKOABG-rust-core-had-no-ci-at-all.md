---
trdd-id: NDKKOABG
title: rust-core was never built or tested by CI — add the job, with caching
column: human_review
created: 2026-08-27T22:45:45+0200
updated: 2026-10-04T12:47:44+0200
current-owner: main-session
task-type: infra
scope: project
project-id: agentlenspro
parent-trdd: DMWOBWFH
min-approval-requirement: none
relevant-rules: []
implementation-commits: [36277dee, 1ecb1935]
---

# rust-core was never built or tested by CI — add the job, with caching

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

This card's acceptance is PROSE, not checkboxes; the reviewing agent extracted the claims and
verified each. Report: `reports/ai-review/20260905_090658+0200-NDKKOABG.md`.

**OBSERVED BY THE ORCHESTRATOR — and it corrects a coarser claim I had been repeating.** The
newest `CI` workflow run on `origin/main` (`3e294e16`, id 33667160582) is `failure` OVERALL, but
per job:

| job | result |
|---|---|
| **`rust`** — the job THIS card added | **success** |
| `build-alcore` | success |
| `browser-smoke` | failure |
| `build-and-test (20)` / `(22)` | failure |

So "CI is red on `main`" is true at the workflow level and was hiding the thing that matters here:
**the job this card exists to add is green.** The red belongs to TRDD-EJDNNDY3, whose fix has never
been pushed — **the leading explanation, not a verified one**: EJDNNDY3 documents a cause for
exactly these jobs failing and its fix `48e8193a` is unpushed, but the failure LOGS were not read,
so a second independent breakage among the 253 unpushed commits is not excluded. A workflow-level
verdict is the wrong granularity for a card that adds ONE job — check the job, not the run.

**Does that green run actually cover THIS card's work?** It would not, if the `rust` job postdated
`origin/main` — the branch is 253 commits behind, so a green run there could easily have never seen
the card's code. Checked: the `rust` job IS present at `3e294e16` (`ci.yml:235`, with
`Swatinem/rust-cache` and the clippy step), running VERBATIM this card's own two gates:

```
cargo clippy --manifest-path rust-core/Cargo.toml --workspace --all-targets -- -D warnings
cargo test  --manifest-path rust-core/Cargo.toml --workspace
```

And the coverage is **self-verifying**: this card records clippy as **red on arrival** until its 16
source fixes landed, and the `empty_spool()` fixture fix as required for `--workspace` to pass on a
fresh clone (CI is always a fresh clone). Both steps are GREEN at that SHA, so the fixes are in it —
the job could not pass without them. **The work therefore landed on `origin/main` BEFORE the branch
fell behind; the 253 unpushed commits are LATER work.** A review pass argued the opposite — that a
253-commit-old tip cannot have seen this card's code — reasoning from the branch gap without
checking whether the work predated it. Reasonable prior, wrong conclusion, and the command that
settles it is one `git show <sha>:.github/workflows/ci.yml`.

**ATTRIBUTION, settled by lineage rather than by inference — because green alone could not do it.**
A later pass caught that "green clippy ⇒ this card's fixes are in that SHA" skips a step: green
proves the DEFECTS ARE ABSENT, not that THIS card's commits are why. Another commit could have
fixed those lints incidentally. Closed with `git log 3e294e16 --grep=NDKKOABG`:
**`36277dee`** (adds the job) and **`1ecb1935`** (pins the `workspaces: rust-core` rationale) are
this card's own commits and both are ancestors of `3e294e16`. Lineage, not consequence.
`implementation-commits:` is now populated with them — it was the missing link in TWO consecutive
reviews, which is what makes it a real defect rather than the cosmetic gap it was first called.

**And the field's VALUE was checked, because a wrong one is worse than the empty one it replaced.**
Ancestry: `git merge-base --is-ancestor` says YES for both (also true by construction — `git log
<sha> --grep=` walks only that SHA's history). Contents: `36277dee` is **14 files, +244/−56**, and
touches exactly the sites this card names — `cbreport_parity.rs` (+15/−1, the `empty_spool()` fix),
`agentlens-ingest/src/lib.rs` (+87, the `items_after_test_module` move), `span_window.rs`,
`log_reader_parity.rs`, `ui.rs`, `pass.rs`. Completeness: the only other `--grep` hit was
`de1df748`, a board-drain docs commit, correctly excluded.

**Note what that check found on the way**: `36277dee`'s subject is *"add the job"* and its diff
carries the sixteen fixes. A subject naming one thing while the diff carries another is this
project's own recurring lesson (see TRDD-QE114936, where a subject reading "the last two" carried
all nineteen sites) — here it appeared inside a commit being cited AS the evidence.

**REPORTED BY THE REVIEWING AGENT:** clippy exit 0 locally, the fixture fix confirmed, and
no-fmt-check confirmed. It also notes one cosmetic gap: `implementation-commits:` is empty.

**Still open, from this card's own NEXT ACTION**: whether the COLD-cache path fits inside
`timeout-minutes: 40`. The green run at `3e294e16` says the job passes; it does not say it passed
from a cold cache. Not a blocker for the verdict — the card's claim is that the gate exists and is
green — but the timeout question is unanswered and belongs to whoever takes it further.

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
- 2026-09-24T08:57:36+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.

## Notes

2026-10-04: code and tests verified at HEAD 7dab99a0 (report 20261004_123602+0200-close-verify-cv3.md); stays in human_review because boxes 2 and 5 (rust CI job green, cold-cache fits the 40 min timeout) were only ever true on the remote CI at the older commit 3e294e16; the owner confirms after the next deploy / push.
