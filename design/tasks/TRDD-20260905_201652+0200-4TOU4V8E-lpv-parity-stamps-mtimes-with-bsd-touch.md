---
trdd-id: 4TOU4V8E
title: lpv_parity stamps fixture mtimes through touch -d @epoch, which BSD touch rejects
column: dev
created: 2026-09-05T20:16:52+0200
updated: 2026-09-05T20:16:52+0200
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
(`reports_dev/mvr6pxc0-cargo-test-20260905_1715.txt`, mtime 19:57) ends at binary 70 of 98 with
`tests/lpv_parity.rs`: 2 passed, 8 failed, every failure `panicked at lpv_parity.rs:39:9: failed to
stamp …/fixtures/lpv-home/proj-b/sess-noskills.jsonl`. Cargo fail-fasts, so the remaining 28
binaries never ran — MVR6PXC0's gate is INCOMPLETE, not red on its own diff.

**Cause, verified first-hand:** `stamp_mtimes` shells out to `touch -d @<secs>`. On this machine
`command -v touch` → `/usr/bin/touch` (BSD; `/usr/bin` precedes the coreutils gnubin at PATH
position 27). BSD touch: `touch -d @1754053200 <file>` → exit 1, *"out of range or illegal time
specification: YYYY-MM-DDThh:mm:SS[.frac][tz]"*. The source comment claims `touch -d @<epoch>`
"is POSIX" — it is a GNU extension. The comment "No std API sets mtime" is also stale:
`std::fs::File::set_modified` is stable since Rust 1.75 (toolchain here: 1.97.0).

**The fixture files currently carry the oracle's exact mtimes** (Aug 1 15:00/16:00/19:00 +0200
= `lpv-expected.json` `mtimes` ÷ 1000), so some earlier run DID stamp them — with GNU touch first
on PATH, or an equivalent. That is the hidden-local-state shape from ATOM-KH8H-N8RH: green on one
PATH, red on another, same tree.

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
any full-suite run on a stock macOS PATH — 28 binaries on 2026-09-05. CI (TRDD-NDKKOABG) will run
on ubuntu with GNU touch and stay green, so this is exactly the class of local-only red that
never reaches CI (ATOM-2PSS-WR4Q's inverse).

## Notes and lessons learned

## Approval log
