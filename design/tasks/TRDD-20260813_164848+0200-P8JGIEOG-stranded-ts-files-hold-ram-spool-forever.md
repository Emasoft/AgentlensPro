---
trdd-id: P8JGIEOG
title: Stranded ts-mismatch files hold RAM-spool capacity forever with no reclaim path
column: complete
created: 2026-08-13T16:48:48+0200
updated: 2026-08-18T13:30:00+0200
implementation-commits: [4a597ef]
current-owner: agentlenspro-main
task-type: bugfix
severity: medium
scope: project
project-id: agentlenspro
labels: [spool, ingest, capacity]
---

# Stranded ts-mismatch files hold RAM-spool capacity forever with no reclaim path

From the 2026-08-13 whole-codebase review (verified finding, `src/store/ingestPass.ts:286` add /
`:321` skip). The `strandedNames` park is CORRECT against its own problem — a durable-named file
failing verify ONLY on capture-ts is a livelock (bytes proven, re-ingest is a dedup no-op that can
never repair the stored ts row), so parking it ends the re-read/re-hash/re-fail loop. What the park
lacks is a CAPACITY story: a parked file stays on the fixed-size RAM spool forever, and nothing
ever re-homes or reclaims it.

## Failure scenario (verifier's, confirmed against the code)

A bulk wrong-ts event (e.g. a migration writing wrong capture times) parks thousands of files. The
2GB RAM spool sits permanently below the backpressure floor; `applySpoolBackpressure` redirects
all new sessions to SSD indefinitely; RAM capture is effectively dead until a human deletes files
by hand. `res.strandedTs` reports the names once, but no report changes the capacity math.

## Why this was NOT fixed in the review pass

The honest fix changes behavior and needs its own falsification: relocate stranded files off the
RAM spool into the legacy SSD bodies dir (durable, off the scarce resource, name preserved so the
delete-gate/dedup invariants hold, mtime preserved because it is the only true capture record —
`cp -p` semantics, verify, then unlink the spool copy). That touches the delete-gate invariant
("never delete unproven bytes" — a MOVE must prove the destination copy first, same discipline as
`compressSealedSegments`' verify-before-delete) and deserves a red-first test with a real parked
file, not a drive-by edit inside a 10-finding batch.

## Acceptance

- [x] A stranded file is relocated from the RAM spool to the legacy SSD dir with name + mtime
      preserved, destination verified byte-identical BEFORE the spool copy is unlinked.
      (`relocateStrandedFile`, tmp+rename+verify+fsync; mtime asserted to the second in the test.)
- [x] `strandedNames` keeps parking it at its new location (zero I/O per pass — the livelock fix
      must survive the move). (Shared set untouched by the move; second-pass test counts ZERO reads
      of the relocated name via the readFile seam.)
- [x] A red-first test: park a file, run the reclaim, assert spool freed + SSD copy verified +
      still skipped by the next ingest pass. (3 tests in src/test/ingestPass.test.ts — happy path,
      different-bytes collision keeps the spool copy + names the failure, identical-destination
      frees without rewrite.)
- [x] The backpressure floor math is re-checked with the reclaim in place: spool usage is measured
      by SCANNING the dir (stagedBodyBytes / the per-target liveBytes readdir in
      archiveOtelBodies), so a relocated file leaves the measurement the moment it leaves the
      mount — no separate accounting to fix. bytesFreed reports the reclaimed spool bytes.

## Approval log

- 2026-08-18T13:30:00+0200 — APPROVED by USER (batch "complete all TRDD") and IMPLEMENTED in
  4a597ef. Volatile-source passes get `relocateStrandedTo: LEGACY_BODIES_DIR`; durable targets
  deliberately get none (durable→durable relocation is churn). Per-pass 3-strike breaker stops a
  directory-level failure from becoming a copy-per-file livelock. Suite 2377 passing. Column →
  complete; rides the next publish.
