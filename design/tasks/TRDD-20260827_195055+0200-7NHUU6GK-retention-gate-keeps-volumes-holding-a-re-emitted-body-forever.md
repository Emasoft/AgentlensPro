---
trdd-id: 7NHUU6GK
title: The archive retention gate keeps a volume forever when it holds a re-emitted body
column: dev
created: 2026-08-27T19:50:55+0200
updated: 2026-11-16T23:49:28+0100
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [store, retention, bodies]
relevant-rules: []
created-by: TRDD-6SPXOV0P option-A advisor consult
parent-trdd: 6SPXOV0P
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:30:52+0100
status: tasked
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

## ⏵ 2026-09-05 — this card is now the ONLY thing holding its parent open

`parent-trdd: 6SPXOV0P` has been AI-review APPROVED with all 7 acceptance boxes green. A parent
cannot reach `complete` until every EHT is terminal, and this is its EHT — so nothing about
6SPXOV0P is outstanding except this card sitting in `backburner`.

**"Why LOW" below is still correct on its own merits and is NOT retracted** — the failure mode is
a volume kept, not data lost. What changed is not this card's severity but its COST OF DELAY: it
now also holds a finished card open. That is a scheduling fact, not a severity one, and `priority:
4` is left alone deliberately rather than inflated to manufacture urgency the defect does not have.

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

## STATE

2026-11-16 23:30 — CODE READ and PLAN (main agent, deciding in the owner's stead; overrulable). FACTS: the card's standalone/server.ts lines no longer exist (the TS server was retired in 567fc5c2) and the age-out sweep purgeArchiveVolumes was never ported (rust-core/crates/agentlens-core/src/body_archive.rs line 6). The only live delete gate is the operator route POST /api/bodies/purge (body_archive.rs, the loop at about line 371), which keeps any volume where verify_volume_in_store returns ok false. A ts-only failure is recognised in the live pass by its reason text (agentlens-store/src/pass.rs about line 658: contains 'stored ts ' and '!= capture time'), and that text is only reached after the sha256 reconstruction and the row lookup passed. PLAN: (1) export one predicate is_ts_only_failure(reason) from agentlens-store and use it in pass.rs too, so there is one definition; (2) add a count ts_only to VolumeVerifyResult WITHOUT changing ok, verified or failed, so the parity test against the TS oracle (tests/bodyarchive_parity.rs) is untouched; (3) in the purge loop a volume is deletable when ok, OR when every failed reason is ts-only and verified + ts_only equals entries; (4) the reply shape removed/kept/freedBytes is frozen and stays as it is; the distinction goes in the log line: per kept volume, how many lumps have unproven bytes and how many only a moved ts row; (5) verify_bodies_in_store_cached and TS_TOLERANCE_MS are not touched. DECISION FLAGGED TO THE OWNER: the header of body_archive.rs records a USER directive of 2026-07-15 (TRDD-K3WDPR7M) that a volume is deleted only after bytes AND the capture-ts row are proven. This plan relaxes the ts half for a re-emitted body, as TRDD-6SPXOV0P already did for the live pass. Grounds: the bytes are proven bit-exact, the store already holds a row for the same name, and the .idx sidecar that carries the capture time is never deleted. The purge stays an operator act. The acceptance wording 'purges on age-out' is read as 'is deleted by the purge route', since no age-out sweep exists.
2026-11-16 23:46 — WORKER STOPPED UNFINISHED; RESULT HELD, NOT COMMITTED. In the tree, uncommitted: rust-core/crates/agentlens-core/src/body_archive.rs, rust-core/crates/agentlens-store/src/lib.rs and pass.rs (modified), rust-core/crates/agentlens-core/tests/purge_ts_only.rs (new). Outputs under reports_dev/7NHUU6GK/: the new test file and bodyarchive_parity ran, the store lib tests ran; the clippy output holds 2 lines and no result; the mutation check was not run; no report was written. OPEN before any commit: (1) the owner sees the relaxed delete-gate decision above; (2) the harness review asks for a structured verdict (a flag on VerifyResult) or an anchored match instead of a substring match on free text, because other reasons embed the lump name; (3) read the function that writes 'stored ts ... != capture time' and confirm the order of checks from the code, not from the pass.rs comment; (4) confirm from code that no path deletes the .idx sidecar; (5) say why a volume needs no content gate when the live pass has one; (6) clippy and the mutation check. Work on this card is paused for the owner's new directive (project-wide transcript search).
2026-11-16 23:49 — CORRECTION to the line above: the worker resumed and finished after that note. Its report (reports_dev/7NHUU6GK/20261116_234905+0100-impl-report.md) states: 3 new tests pass, bodyarchive_parity passes, the store lib tests (43) pass, clippy -D warnings passes, the mutation check failed test (a) as expected and the restore matched byte for byte. Two deviations from the plan: is_ts_only_failure matches the END of the reason string instead of a substring (this answers open point 2), with one store unit test for it. These are the worker's statements; the main agent has not yet re-read the diff or re-run a test. Open points 1, 3, 4, 5 stand, and the header of body_archive.rs still states the old bytes-and-ts rule. The result stays UNCOMMITTED.

## Approval log

- 2026-11-16T23:30:52+0100 — column → dev by main-agent@agentlenspro. taken off backburner: it is the only card holding TRDD-6SPXOV0P open
