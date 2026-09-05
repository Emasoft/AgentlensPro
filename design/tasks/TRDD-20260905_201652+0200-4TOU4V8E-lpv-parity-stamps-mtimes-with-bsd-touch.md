---
trdd-id: 4TOU4V8E
title: lpv_parity stamps fixture mtimes through touch -d @epoch, which BSD touch rejects
column: dev
created: 2026-09-05T20:16:52+0200
updated: 2026-09-05T20:24:57+0200
current-owner: agentlenspro-b2
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
relevant-files: [rust-core/crates/agentlens-core/tests/lpv_parity.rs]
labels: [rust-core, tests, portability]
priority: high
implementation-commits: []
---

# lpv_parity stamps fixture mtimes through `touch -d @epoch`, which BSD touch rejects

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-05T20:16

**Measured, not inferred.** The MVR6PXC0 full-suite capture
(`reports_dev/mvr6pxc0-cargo-test-20260905_1715.txt`, mtime 19:57) ends on `tests/lpv_parity.rs`:
2 passed, 8 failed, every failure `panicked at lpv_parity.rs:39:9: failed to stamp
…/fixtures/lpv-home/proj-b/sess-noskills.jsonl` (the FIRST key of the oracle's `mtimes` table, so
each test dies on entry 1 — all eight messages read, all identical). Counted from the capture's
`Running` lines: 70 binaries ran = 3 unittest binaries + 67 integration binaries, `lpv_parity`
being the 67th; cargo's last line is `error: test failed, to rerun pass …` and no `Running`
follows, so the run ended there (fail-fast). The `tests/*.rs` names sorting after `lpv_parity`
number 31, plus doctests — none ran. MVR6PXC0's gate is INCOMPLETE, not red on its own diff.
The run's exit code was never captured (its `echo EXIT` went to the killed task's stdout); do not
cite one.

**Cause, verified first-hand:** `stamp_mtimes` shells out to `touch -d @<secs>`. On this machine
`command -v touch` → `/usr/bin/touch` (BSD; `/usr/bin` precedes the coreutils gnubin at PATH
position 27). BSD touch: `touch -d @1754053200 <file>` → exit 1, *"out of range or illegal time
specification: YYYY-MM-DDThh:mm:SS[.frac][tz]"*. The source comment claims `touch -d @<epoch>`
"is POSIX" — it is a GNU extension. The comment "No std API sets mtime" is also stale:
`std::fs::File::set_modified` is stable since Rust 1.75 (toolchain here: 1.97.0).

**The fixture files currently carry the oracle's exact mtimes** (Aug 1 15:00/16:00/19:00 +0200
= `lpv-expected.json` `mtimes` ÷ 1000), older than the Aug 20 checkout — so something stamped
them post-checkout. That something is most likely the generator itself:
`fixtures/gen-lpv-expected.mjs:50` calls `utimesSync` on every fixture before publishing the
table. Whether a cargo run with GNU touch first on PATH ever stamped them is NOT established and
is not needed for the diagnosis. Either way the test's own stamping step has never worked with
`/usr/bin/touch` first on PATH.

**NEXT ACTION:** replace the subprocess in `stamp_mtimes` with
`File::options().write(true).open(&path)?.set_modified(UNIX_EPOCH + Duration::from_millis(ms))`
(keep the ms precision the oracle publishes; no `f64` division). Drop the two false comment
claims, keep the WHY (git does not preserve mtimes; oracle publishes the table). Gate:
`cargo test -p agentlens-core --test lpv_parity` → 10/10. Then MVR6PXC0 re-runs the remaining
binaries (`--no-fail-fast` this time) before its own commit.

## Acceptance

- [ ] `stamp_mtimes` uses `std::fs::File::set_modified`; no `touch` subprocess remains in `tests/`.
- [ ] `cargo test -p agentlens-core --test lpv_parity` → 10 passed on this machine with
      `/usr/bin/touch` first on PATH (the failing precondition, reproduced above).
- [ ] The comment names the real reason the mtimes are stamped and cites nothing false.

## Why this matters beyond one binary

Fail-fast means this one non-portable helper hides every binary sorted after `lpv_parity` from
any full-suite run on a stock macOS PATH — 31 integration binaries plus doctests on 2026-09-05.
CI (TRDD-NDKKOABG) will run
on ubuntu with GNU touch and stay green, so this is exactly the class of local-only red that
never reaches CI (ATOM-2PSS-WR4Q's inverse).

## Notes and lessons learned

## Approval log

- 2026-09-05T20:16:52+0200 — Authored straight into `dev` (Tier 0 bugfix; the fix was delegated in
  the same turn) rather than `backburner`. Orchestrator decision, USER may veto.
- 2026-09-05T20:24 — Review fork on `b5eb2555`: "70 of 98 / 28 never ran" mixed `test result`
  lines (unittests included) with `tests/*.rs` file count; corrected to 3+67 ran, 31 integration
  binaries + doctests never ran. "Some earlier run stamped the mtimes" withdrawn as a proxy — the
  generator's own `utimesSync` explains them.
