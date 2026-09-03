---
trdd-id: 3UJB4MN3
title: Build the typed element store — day-partitioned, denormalized, with the precomputed cache boundary
column: todo
created: 2026-09-03T20:42:45+0200
updated: 2026-09-03T20:42:45+0200
current-owner: unassigned
task-type: feature
severity: HIGH
labels: [store, duckdb, parquet, schema, cache]
relevant-files: [rust-core/crates/agentlens-store/src/lib.rs, rust-core/crates/agentlens-store/src/pass.rs, rust-core/crates/agentlens-store/src/api_call.rs, src/shared/cacheClassification.ts]
blocked-by: []
npt: []
eht: []
release-via: publish
---

# Build the typed element store

Implements the architecture decided in TRDD-2LH25PBB. Every choice there is backed by a measurement;
do not re-litigate them without a new measurement that contradicts the recorded one.

## What to build

An `element` table, one row per TOP-LEVEL wire element (the cache unit) plus one row per SUB-ELEMENT
produced by the section-marker split, written as day-partitioned parquet.

Columns, all typed — never JSON text (measured 8.2× on the numeric fields alone):

| column | type | note |
|---|---|---|
| `body_id`, `session_id` | VARCHAR | denormalized so the hot queries need no join |
| `ts` | TIMESTAMP | drives day partitioning |
| `model`, `element_type`, `name`, `role` | VARCHAR | low cardinality → dictionary |
| `position` | INTEGER | index in CACHE order (tools → system → messages) |
| `path`, `idx` | VARCHAR / INTEGER | logical address as sent |
| `bytes` | INTEGER | exact, never an estimate |
| `breakpoint`, `key_excluded` | BOOLEAN | |
| `content_sha` | VARCHAR | join key to `blobs`, display only |
| `parent_position` | INTEGER | NULL for a top-level element; set on a sub-element |
| `cache_break_index` | INTEGER | the precomputed boundary; **NULL = not yet computed** |
| `cls` | VARCHAR | `cache-read` / `cache-write` / `fresh-input` |

`cache_break_index` is denormalized onto every row so classification is `position <=
cache_break_index`, one integer comparison, no diff and no join at query time.

## Instructions that are load-bearing

1. **Build element identity with `elementKey()`** from `src/shared/cacheClassification.ts`. Raw bytes
   agreed with billed usage on 0 of 300 real turns; the normalized form agrees on 296.
2. **19% of message elements are inlined skeleton literals with a NULL `path`.** Building the element
   list from `path IN (tools,system,messages)` misaligns the two requests and reports a phantom
   divergence. Reconstruct by walking `pos` and tracking the `"messages":[` / `"system":[` /
   `"tools":[` separators; verify the reconstructed counter against each blob's own `idx` (the
   validation run got 0 mismatches over 300 bodies, so a nonzero count means the walk is wrong).
3. **A sub-element INHERITS its parent's `cls`** and never carries its own boundary. The API caches
   top-level array entries; a `<system-reminder>` inside `messages[143]` is not separately cacheable.
4. **NULL boundary means "not computed", never "no break".** The predecessor may not be ingested yet;
   a backfill pass fills it. Anything reading this column must distinguish the two.
5. **Do not drop bytes.** An unrecognised section is typed `prose`; a message's sub-elements must sum
   to the message's own byte count.

## Acceptance

- [ ] Round-trip: every body still rebuilds to a matching sha256 after the schema change.
- [ ] Σ sub-element bytes == parent element bytes, on every message, no exceptions.
- [ ] A time-filtered query prunes to that day's files (measure it; the pruning win was 34×).
- [ ] Per-turn classification, bytes by element type, and catalog presence all answer from the
      element table ALONE — no join to `blobs`.
- [ ] The 273M punctuation rows are gone and the JSON skeleton still reconstructs.
- [ ] Every column has exactly one physical type across every file (TRDD-HCK5162J's guard).
- [ ] Ingest throughput does not regress: measure bodies/second before and after on the same corpus.

## Open questions to answer WITH MEASUREMENTS, not opinion

1. **Row-group size.** Dictionary encoding is per column chunk, so the row-group size decides how far
   a dictionary is shared. Measure the store's total bytes at 100k, 500k and 1M rows per group. The
   84-tool catalog recurring across a day is the case to watch.
2. **Does denormalizing `session_id`/`ts`/`model` onto every element row cost more than the join it
   saves?** It should compress to almost nothing under RLE, but measure it: write the element table
   with and without those three columns and compare bytes, then compare query time against the
   3.17s three-table join.
3. **Sub-element rows multiply the row count.** Measure the new row count and the resulting store
   size against today's 3.4 GB before committing to storing sub-elements as rows rather than as an
   offset list on the parent.
4. **Is `content_sha` worth storing per row, or should the element table hold a small integer
   dictionary id?** Measure both; the sha is 64 chars of hex and appears on every row.
