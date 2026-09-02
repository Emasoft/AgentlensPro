---
trdd-id: 2TQHNMEC
title: Every bodies pass rebuilds the dedup sets by scanning every blob and bodies part file
column: backburner
created: 2026-09-02T13:10:29+0200
updated: 2026-09-02T13:10:29+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
parent-trdd: 768NEX6E
related: [768NEX6E, ZW4APOPI, 5PUD8RKE]
---

# Every bodies pass rebuilds the dedup sets by scanning every blob and bodies part file

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured (TRDD-768NEX6E, 2026-09-02 12:53–13:08, after its steps 1+2 landed):** a bodies pass
  with 2 files to ingest still takes **14 s**; typical passes 14–23 s, once a minute, on 2 threads /
  2 GB. The floor is `open_store` (`agentlens-store/src/lib.rs`): every pass opens a FRESH in-memory
  DuckDB and rebuilds `known` + `blob_files` with `SELECT DISTINCT sha, filename FROM read_parquet([all
  6,798 blob parts])` and `body_durable` with `INSERT … SELECT * FROM read_parquet([all 1,843 bodies
  parts])`. Step 2's index only scoped the VERIFY read; the dedup-set rebuild is still O(corpus).
- **Why the obvious fix is unsafe as-is (768NEX6E step 3):** keeping the `Store` open across passes
  would skip both scans, but retention/purge deletes part files under it; a cached `known` would then
  claim a blob exists that is gone, dedup would skip writing it, and the new body would reference a
  missing blob — data loss. Only safe with an inventory check.
- **NEXT ACTION:** persist the index between passes WITH an inventory check — e.g. keep the `Store`
  (or just `known`/`blob_files`/`body_ids`) across passes and, at pass start, diff the part-file
  list (`part_files()` names + mtimes) against the one the sets were built from: unchanged ⇒ reuse;
  any part missing or new ⇒ full rebuild as today. Purge and the pass already serialise on
  `with_chores_lock`, so the diff is race-free. Measure before/after with the `bodies pass: … in N ms`
  line (768NEX6E box 2's CPU/bytes belong here too).

## Acceptance

- [ ] A pass whose part-file inventory is unchanged since the last pass does NOT re-scan the blob or
      bodies corpus; a test proves the sets are reused, and a second test proves a deleted part file
      forces the full rebuild (the data-loss guard).
- [ ] Typical pass wall time on the reference store drops from 14–23 s to < 3 s (log line evidence,
      ≥10 consecutive passes, sessions already running — no fleet soak).
- [ ] CPU time and bytes read per pass measured before/after (closes 768NEX6E box 2).

## Notes and lessons learned

- Empty section on creation.
