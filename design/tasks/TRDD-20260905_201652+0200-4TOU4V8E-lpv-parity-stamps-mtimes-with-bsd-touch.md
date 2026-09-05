---
trdd-id: 4TOU4V8E
title: lpv_parity stamps fixture mtimes through touch -d @epoch, which BSD touch rejects
column: dev
created: 2026-09-05T20:16:52+0200
updated: 2026-09-05T20:29:04+0200
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
number 31 — none ran — plus the `Doc-tests` step (INFERRED: `Cargo.toml` sets no `doctest =
false`, and the capture never reached that step). MVR6PXC0's gate is INCOMPLETE, not red on its
own diff. The run exited on its own with **101**: the prior session's task output
`tasks/be71t16hu.output` opens `Loading .zprofile at 17:15:40` and ends `cargo-test EXIT=101`,
and that file's mtime is 19:57:22 — the same second as the capture's. No output names the
capture path (the redirection lived in the tool call, not in stdout), so the binding is by
start time and by that shared last-write second; the two other `cargo-test EXIT` outputs in the
directory are 16:04 and 16:09 scoped runs. A killed task never writes its trailing `echo`, so
the EXIT line itself refutes "killed by the clear" without any clear-time arithmetic.

**Cause, verified first-hand:** `stamp_mtimes` shells out to `touch -d @<secs>`. On this machine
`command -v touch` → `/usr/bin/touch` (BSD; `/usr/bin` precedes the coreutils gnubin at PATH
position 27). BSD touch: `touch -d @1754053200 <file>` → exit 1, *"out of range or illegal time
specification: YYYY-MM-DDThh:mm:SS[.frac][tz]"*. The source comment claims `touch -d @<epoch>`
"is POSIX" — it is a GNU extension. The comment "No std API sets mtime" is also stale:
`std::fs::File::set_modified` is stable since Rust 1.75 (toolchain here: 1.97.0).

**The fixture files currently carry the oracle's exact mtimes** (Aug 1 15:00/16:00/19:00 +0200
= `lpv-expected.json` `mtimes` ÷ 1000). They are the generator's own pre-commit stamps:
`fixtures/gen-lpv-expected.mjs:50` calls `utimesSync` on every fixture before publishing the
table. Any git-side path that could have produced the files (clone, checkout, restore, stash
pop) sets mtime to that operation's clock, which is on or after the 2026-08-20 fixture commit
`8e1f8cc7`; the observed Aug 1 is EARLIER than all of them, so only an explicit utimes-style
stamp explains it — the argument needs no repo-history audit. Whether a cargo run
with GNU touch first on PATH ever stamped them is NOT established and is not needed for the
diagnosis. Either way the test's own stamping step has never worked with `/usr/bin/touch` first
on PATH.

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
- 2026-09-05T20:27 — Review fork on `b4a00d79`: "exit code never captured, task killed by the
  clear" was asserted against the evidence. Settled: `tasks/be71t16hu.output` holds
  `cargo-test EXIT=101`; capture mtime 19:57:22 is after the 19:47 clear. "Killed" dropped, 101
  cited. Doctests marked INFERRED. Stamp form changed to `Duration::from_secs_f64(ms / 1000.0)`
  (fails fast on NaN/negative where an `as u64` cast would stamp epoch 0).
- 2026-09-05T20:29 — Review fork on `f6abba9d`: the be71t16hu ↔ capture pairing rested on the
  handoff's say-so. Settled by the task output's own content: starts 17:15:40, ends
  `cargo-test EXIT=101`, last written 19:57:22 = the capture's second; the other two outputs are
  16:04/16:09 scoped runs. "Killed" now refuted by the EXIT line itself, clear-time arithmetic
  dropped. "Never checked out here" replaced by the provenance-independent mtime argument.
