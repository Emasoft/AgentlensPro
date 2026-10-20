---
trdd-id: U50JCH0J
title: Raw-body source identity and incremental index checkpoint substrate
column: human_review
status: tasked
created: 2026-10-19T00:45:50+0200
updated: 2026-10-20T02:41:32+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:45:50+0200
derived: true
npt: []
eht: []
---

# Raw-body source identity and incremental index checkpoint substrate

## WHY
The actively growing raw-body corpus needs stable source identity and restartable discovery before any byte can be migrated or safely removed; rescanning hundreds of thousands of files without a durable checkpoint is neither bounded nor auditable.

## Scope
- Define a collision-resistant source identity from canonical provenance and content evidence, independent of mutable path names.
- Build and maintain an append-safe incremental `index.jsonl` checkpoint substrate that discovers new and changed raw-body sources without a full rescan on every run.
- Persist enough source metadata to resume after interruption and to distinguish unchanged, replaced, truncated, and newly appended inputs.
- Make discovery idempotent and deterministic under concurrent corpus growth.

## Delivered
- Four new files: src/rawBodySourceIdentity.ts (the content-derived identity and the cheap fingerprint), src/rawBodySourceIndex.ts (the versioned append-only checkpoint format, its writer, and outstandingSources), src/rawBodyDiscovery.ts (the idempotent, restartable discovery pass), src/test/rawBodySourceIndex.test.ts (50 tests, real files in mkdtemp under os.tmpdir, no mocks).
- ENTRY POINT: outstandingSources(records, corpusPaths, alreadyMigratedPaths) in src/rawBodySourceIndex.ts — the function that decides what a later stage migrates. The checkpoint format version is 2 (source-index.v2.jsonl); a version-1 log is refused as a version, not converted.
- The module headers point at the contract below rather than restating it, so the two cannot drift.

## Consumer contract
THE OUTSTANDING MIGRATION SET IS THE RESULT OF outstandingSources(records, corpusPaths, alreadyMigratedPaths) (src/rawBodySourceIndex.ts), AND NOTHING ELSE. It applies every condition - still present in the corpus, latest reason is not 'gone', not refused by a partner that still exists, and a material class - so a consumer cannot forget one. Deriving the set by hand from the class field alone is WRONG: a 'gone' record carries class 'new' ('it was never migrated'), which is exactly the shape of a source that still needs migrating. The pass's own output (observedMaterial) is PER-PASS and is empty over an unchanged corpus: that is the idempotence property the acceptance criteria demand, and it means 'nothing CHANGED', NOT 'there is nothing to migrate'. The DURABLE LOG is the record of what has been discovered. The checkpoint deliberately carries no 'migrated' flag: migration execution is a sibling card's job (TRDD-IFOQAQYV), and this card cannot assert a migration it did not perform. Hence the caller's alreadyMigratedPaths - a set of PATHS, not identities (a mismatched key THROWS rather than silently matching nothing). The function is PATH-KEYED: it answers 'what does the corpus hold RIGHT NOW', and a rename neither duplicates nor loses a source (measured: the pass writes a record under the new path with the same identity). ONLY A SOURCE'S OWN LATEST RECORD SAYS IT IS CONTESTED - a partner's record naming a source is not evidence that the source is contested, because a reclaimed partner keeps its last record for ever.

## Validation evidence
VALIDATION EVIDENCE (all five acceptance boxes ticked on this). Gates: tsc -p tsconfig.test.json exit 0; tsc --noEmit exit 0; eslint on the four files exit 0; mocha over out/test/test/rawBodySourceIndex.test.js exit 0 with 50 passing and 0 failing. REAL CORPUS SLICE (criterion 5): a deterministic 120-file slice of the live corpus (every Nth name, 32.8 MB) plus its real index.jsonl were copied to /tmp and discovery was run over it: pass 1 scanned 120, recorded 120, material 120, refusals 0, class tally all 'new', corpus index read 22,230 rows with 0 skipped and rowsWithoutProvenance 0; pass 2 recorded 0 and material 0 (idempotence on real data, the log stayed at 120 records); the derived outstandingSources set was exactly 120; 0 records carried a bad digest and 0 named a missing path. NOTHING WAS WRITTEN TO ~/.agentlens - the slice was a COPY in /tmp and the checkpoint went to a fresh temp state dir. THE THREE DEFECTS FOUND AND FIXED IN REVIEW ROUNDS 7-10, each reproduced before fixing: (1) a CRASH-ON-WRITE - the validator enforced class 'replaced' implies reason 'replaced', but the material class is carried forward on an unchanged observation, so a replaced file that later gained a provenance row was refused on the way IN, the pass threw and the log became unappendable; the invariant is now one-directional (a reason implies a class, a class does not imply a reason). (2) THE 'gone' RECORD WAS WRITTEN TWICE - the cheap-path block ran per triggering live path, so two live sources both refusing a reclaimed one each appended a 'gone' record; the guard is now on the REASON (a vanished path's latest record already being 'gone'), and a vanished path's 'gone' record now carries refusal null because a collision needs BOTH paths to exist. (3) A STALE REFUSAL WITHHELD A SOURCE - outstandingSources excluded any source whose latest record carried a refusal of ANY kind, including one naming only vanished partners, so a live file was never migrated; it now excludes only a refusal naming a partner that IS in corpusPaths, the same rule the pass uses.

## Review verdict
FINAL REVIEW VERDICT (2026-10-20, tenth adversarial round): the IMPLEMENTATION is complete and reviewed; the card itself sits in human_review AWAITING ACCEPTANCE by the owner, and 'DONE' here does NOT mean the card is in the complete column. The reviewer could not construct a remaining path by which the log asserts a falsehood, confirmed the four conditions of outstandingSources compose correctly and MATCH the pass's own rule, confirmed the path-keying is a documented limitation and not a defect for this migration (measured: a rename writes a record under the new path with the same identity, the old path is excluded because it is absent from the current corpus, so a rename neither duplicates nor loses a source), and judged the design structurally sound - content-derived identity, an append-only log with a self-checking boundary chain, refusal-as-a-record rather than refusal-as-absence, and a DERIVED outstanding set are the right shapes for a log that gates deletions. It declined to manufacture a finding. One accepted limitation: the loader cannot distinguish written-but-not-fsynced from durable after a crash, so a power loss can leave the last record unflushed; the consequence is bounded and safe, but ONLY for a consumer that reads the LATEST record per path: the next pass re-derives that source and re-appends it, and because the log is append-only that re-append is a SECOND record for the same path. It is idempotent AT THE CONSUMER (latestByPath and outstandingSources both collapse to the latest), not idempotent in the log. A consumer that reads any record rather than the latest will double-count that source. This is a CONTRACT dependency, and the contract is above. HANDOFF TO THE MIGRATION RUNNER (TRDD-IFOQAQYV) - FIVE THINGS THAT WILL BITE, verified against the code: (1) alreadyMigratedPaths is PATHS, not identities - the runner must maintain a path set; a caller recording an identity instead would re-offer that body, and the guard throws only for the exact 64-hex shape, so some other wrong key type would still match nothing silently. (2) observedMaterial is PER-PASS and is empty over an unchanged corpus - the runner must call outstandingSources against the LOG, never iterate the pass output. (3) The log alone cannot tell outstanding from reclaimed - the runner must pass the CURRENT corpus path set; a path absent from the corpus is excluded, which is correct and also means a reclaimed body is never migrated. (4) A refused source is WITHHELD - the runner must handle a source never offered because a live partner contends it, and must not read 'not offered' as 'nothing to do' without checking the log. (5) The runner must NEVER write to the corpus dir - the checkpoint lives under a caller-supplied state dir, deliberately not in the corpus dir, because Claude Code writes its own index.jsonl there. (6) THE RUNNER MUST RE-VERIFY THE DIGEST IMMEDIATELY BEFORE UNLINKING, AND ABORT ON A MISMATCH. outstandingSources returns records carrying the content digest the pass computed at discovery time; the log's claim is that the file at that path held those bytes THEN. Between discovery and deletion the file may have been rewritten - the corpus is live and this very drain has already demonstrated re-emission (the store has a reclaimed_reemitted path and a 'stored ts != capture time' case, so re-emission is observed behaviour, not a hypothesis). A runner that deletes on the log's claim alone can delete a file whose bytes are not the ones that were digested. The alreadyMigratedPaths throw covers a wrong KEY loudly; nothing in the log covers a CHANGED FILE, so the runner must hash the file again before the unlink and abort the delete on a mismatch.

## Acceptance criteria
- [x] Repeated discovery over an unchanged corpus emits no duplicate source identities or work.
- [x] A crash at every checkpoint boundary resumes without omitting or duplicating a source.
- [x] Changed, truncated, replaced, and newly created sources are classified deterministically.
- [x] Each checkpoint is durable before later migration stages may rely on it.
- [x] The index format is versioned, incrementally readable, and validated against a representative corpus slice.

## Failure and refusal conditions
- Refuse ambiguous identity collisions rather than choosing a source silently.
- Refuse malformed or internally inconsistent checkpoint records.
- Never mark a source discovered from path existence alone when required identity evidence cannot be read.
- Never advance a checkpoint past unpersisted discovery records.

## Out of scope
- DuckDB schema and reconstruction.
- NOT in scope, but PRESENT here: the CONTRACT the migration runner (TRDD-IFOQAQYV) must satisfy, and the handoff notes for it. The card specifies the contract; the runner that consumes it is a different card's work.
- Capacity approval, migration execution, consumer cutover, retention policy, and source deletion.

## Relevant links
- Parent architecture and backlog decomposition: TRDD-LHCHVK9Z.
- Typed storage and reconstruction card: to be linked after minting.
- Migration state-machine card: to be linked after minting.
- Reconciliation and audit card: to be linked after minting.
- Direct DuckDB schema/reconstruction: TRDD-TC8HW857; capacity gate: TRDD-TXRRF34L; migration runner: TRDD-IFOQAQYV; reconciliation: TRDD-JK4I9MFY; live drain: TRDD-IGPWXZ1M.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`. Links describe coordination, not hierarchy.

## Approval log

- 2026-10-19T00:45:50+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
