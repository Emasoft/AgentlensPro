---
trdd-id: P8JGIEOG
title: Stranded ts-mismatch files hold RAM-spool capacity forever with no reclaim path
column: backburner
created: 2026-08-13T16:48:48+0200
updated: 2026-08-13T16:48:48+0200
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

- [ ] A stranded file is relocated from the RAM spool to the legacy SSD dir with name + mtime
      preserved, destination verified byte-identical BEFORE the spool copy is unlinked.
- [ ] `strandedNames` keeps parking it at its new location (zero I/O per pass — the livelock fix
      must survive the move).
- [ ] A red-first test: park a file, run the reclaim, assert spool freed + SSD copy verified +
      still skipped by the next ingest pass.
- [ ] The backpressure floor math is re-checked with the reclaim in place (the spool can no longer
      be permanently pinned below the floor by parked files).
