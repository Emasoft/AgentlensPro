---
trdd-id: 2F1BHVZ7
title: The card-store reuse path OOMs at 256MiB on a large corpus and the boot read's margin over the pool is never reported
column: todo
status: tasked
created: 2026-10-20T21:55:11+0200
updated: 2026-10-20T22:29:48+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-20T21:55:11+0200
---

# The card-store reuse path OOMs at 256MiB once the cards table is too big to read, and the recovery is a full rewrite

MEASURED 2026-10-20 against the live log (`~/.agentlens/server.log`), across the whole log and the corpus file's own sizes.

WHAT THE LOG SAYS — the card-store history in full, four kinds of line:
- **17 refusals, all before the 20:57 deploy**, `00:07:32` -> `17:32:06` on 2026-10-20, in the old wording: `card store — NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory Error: … (255.3-256.0 MiB/256.0 MiB used)`. Every one of them is an out-of-memory refusal of the cold read; the pre-deploy binary called it "NOT reusing" and took the rebuild path.
- **1 refusal after the deploy**, `20:58:30`, in the new wording: `card store — reusing cards.duckdb ran out of memory at 256MiB (the cards table is unreadable: Out of Memory Error: could not allocate block of size 1.9 MiB (254.4 MiB/256.0 MiB used)`. The new binary classifies the same failure as `Refusal::OutOfMemory` and takes the LOSSLESS REWRITE path.
- **1 rewrite**, `20:58:35`: `card store — rewrote cards.duckdb compactly: 42695 cards, 805318656 bytes before, 145502208 after; reusing it at memory limit 256MiB`.
- **842 successful reuses** in the whole log (`reusing cards.duckdb: N cards, …`), of which **18 are after the rewrite**: `21:59:23` (42,975), `22:05:52` (42,979), `22:12:01` (42,986), `22:22:39` (42,994).

THE THRESHOLD IS BRACKETED, AND THAT IS THE USEFUL FACT. The file that failed was **805,318,656 bytes**. The file that works is **145,502,208 bytes** right after the rewrite, and it has since regrown to **336,867,328 bytes (321.3 MiB)** at 22:24 with every reuse still succeeding. So the cold read of the card table fails somewhere between **321 MiB and 785 MiB of file size**, at a 256 MiB pool. The margin is not a function of file size alone (a 321 MiB file reads fine in a 256 MiB pool), because the read is bounded by what the scan MATERIALISES, not by the file's length on disk.

WHERE THE READ IS. The failing read is the resident-layer scan (`RESIDENT_SCAN_SQL = 'SELECT session_id, card FROM cards ORDER BY seq'`, card_store.rs:130) run by `load_resident` (card_store.rs:487): the sort carries the card TEXT as its payload, so the whole column is materialised. The pool is `card_store::MEMORY_LIMIT = 256 MiB` (card_store.rs:77). The 1024 MiB `REBUILD_MEMORY_LIMIT` (card_store.rs:85) applies to the COPY, not to the read that failed — which is why the copy succeeds and the read does not.

WHAT IS STILL OPEN. The reuse path works HERE because the file was compacted 90 minutes earlier, and nothing guarantees that at the next cold boot on a file that was never compacted. The 17 pre-deploy refusals are the counterexample: 17 boots in one day hit the same wall and each paid a rebuild. The safety net that catches it — the rewrite — is the thing that has to work, and it costs a full corpus rewrite on the boot that hits it.

RELATED AND DISTINCT. TRDD-0BDOV3WC (archived) owned the "never delete a database that failed to READ" rule and the 1024 MiB rewrite; that rule is in the deployed binary and is what made the 20:58 boot non-destructive — the failed read did NOT lose the 805 MB file, it rewrote it. TRDD-T0G38TZ4 owns the `corpus_bytes` aggregate that scanned the whole corpus (a DIFFERENT statement, now replaced by a tracked counter). TRDD-5JZQFVO8 (archived) owned the boot-restore transaction chunking. NONE of them owns the fact that the cold read of the card table has a size ceiling between 321 MiB and 785 MiB, that 17 boots in one day hit it, and that the recovery is a full rewrite.

ACCEPTANCE.
- The reuse path's memory need is BOUNDED and KNOWN, not emergent: either the boot read of the card table is paged so its peak is a stated fraction of the pool, or the read limit is derived from the corpus size, and the choice is stated in one place.
- A cold boot on a file that has NOT been compacted must succeed WITHOUT a full 805 MB rewrite, or the rewrite must be shown to be cheap and bounded — measured, not assumed. A test at the real corpus size asserts it.
- The reuse log line reports the pool usage or the headroom, so the next reader sees the margin instead of inferring it.
- The threshold is pinned by a test: a card table whose file exceeds the pool but whose scan stays under it, and one whose scan does not — both the refusal path and the rewrite path are covered.

## Approval log

- 2026-10-20T21:55:11+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
