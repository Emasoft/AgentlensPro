---
trdd-id: 7NHUU6GK
title: The archive retention gate keeps a volume forever when it holds a re-emitted body
column: backburner
created: 2026-08-27T19:50:55+0200
updated: 2026-08-27T19:50:55+0200
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [store, retention, bodies]
relevant-rules: []
created-by: TRDD-6SPXOV0P option-A advisor consult
parent-trdd: 6SPXOV0P
---

## The gap (verified 2026-08-27 at file:line, not inferred)

TRDD-6SPXOV0P makes the ingest pass treat "durable bytes, ts-only disagreement" as BENIGN, because a
re-emitted body (same name, same bytes, new mtime) is not corruption. That fixes the PASS. The
ARCHIVE retention gate uses the same underlying proof and did not change:

- `standalone/server.ts:833` — `purgeArchiveVolumes(...)` calls `verifyVolumeInStore(...)` and, on
  `!v.ok`, WARNs "aged out but FAILED store verification — KEPT".
- `standalone/server.ts:806` — the comment states the contract: "a volume dies only after EVERY lump
  in it is proven in the store (bytes + capture-ts row)".
- The capture-ts half is the check at `rust-core/crates/agentlens-store/src/lib.rs:586`, the same
  one whose ts-only failure 6SPXOV0P reclassifies for the live pass.

So an archive volume containing even ONE re-emitted body can never pass its gate, and ages out
forever without being purged.

## Why LOW

Fail-SAFE by construction: the failure mode is a volume KEPT, never data deleted, and the WARN says
so on every sweep. It costs disk, not correctness. It also only bites installs that still have
legacy `.wad` volumes.

## The fix, when taken

Give the volume gate the same benign treatment the pass now has: a lump whose bytes reconstruct
bit-exact but whose ts row disagrees is PROVEN for retention purposes — the bytes are what the
archive exists to preserve. Do NOT do this by loosening `TS_TOLERANCE_MS` or
`verify_bodies_in_store_cached`; both are deliberately strict and other proofs depend on them
(the advisor's explicit warning, and the reason 6SPXOV0P's change lives in `pass.rs` alone).

## Acceptance

- [ ] A volume holding a re-emitted body (same name + bytes, mtime moved) purges on age-out.
- [ ] A volume holding a body whose BYTES do not reconstruct is still KEPT — the fail-safe half must
      survive the change.
- [ ] The distinction appears in the WARN text, so an operator can tell "kept because bytes are
      unproven" from "kept because a ts row moved".

## Related

- [[TRDD-6SPXOV0P]] — the parent: the same reclassification, in the live ingest pass.
