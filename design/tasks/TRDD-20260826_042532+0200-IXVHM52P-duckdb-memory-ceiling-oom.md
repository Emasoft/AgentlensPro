---
trdd-id: IXVHM52P
title: The 8GB DuckDB ceiling OOMs a full-store validate — repair-parked fails out of the box
column: todo
created: 2026-08-26T04:25:32+0200
updated: 2026-08-26T04:25:32+0200
current-owner: AgentlensPro session
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
relevant-rules: []
npt: []
eht: []
---

# The 8GB DuckDB ceiling OOMs a full-store validate

## The measurement

`agentlenspro store repair-parked` on the live store (2.7 GB, 1045 parked bodies)
died in `validateStore`:

```
repair FAILED: migration failed: Out of Memory Error: could not allocate block of
size 256.0 KiB (7.4 GiB/7.4 GiB used)
Database is launched in in-memory mode and no temporary directory is specified.
Unused blocks cannot be offloaded to disk.
```

Live store untouched (the staged protocol held — the failure is a refusal, not a
corruption). Re-running with `AGENTLENS_DUCKDB_MEMORY_LIMIT=24GB` got past it.

## Why this is a defect, not a tuning preference

`DEFAULT_MEMORY_LIMIT = '8GB'` (`src/store/db.ts`) is a FIXED constant on a
machine with 64 GB, while `threadCount`'s comment claims it "mirrors memoryLimit"
as a "machine-scaled default" — it does not; only the thread count scales. So the
one operation that must validate EVERY blob and EVERY body is capped at a ceiling
that does not grow with either the machine or the store, and `SET temp_directory
= ''` (deliberate — "an over-limit query must fail, not silently write gigabytes
to the SSD") converts the overflow into a hard failure rather than a slow one.

The consequence is that the documented recovery path for a permanently-parked
body fails on any store large enough to have accumulated parked bodies — i.e.
precisely when it is needed. Nothing in the CLI's output points at the env var
that fixes it.

## Candidate remedies (decide, do not implement all)

1. Scale `DEFAULT_MEMORY_LIMIT` off `os.totalmem()` the way the thread count is
   claimed to (e.g. a generous fraction, floored at today's 8GB) — makes the
   comment true and fixes every caller at once.
2. Raise the ceiling only for the validate/migrate path, which is the one that
   must hold a whole-store working set; leave the serving path conservative.
3. Keep the ceiling and make `validateStore`'s V2 leg stream in bounded chunks
   the way V1 already does (V1's comment says the corpus is larger than RAM and
   "a validator that OOMs is a validator that" — the sentence its own V2 leg then
   violates).
4. At minimum: name `AGENTLENS_DUCKDB_MEMORY_LIMIT` in the failure message, so
   the operator is not left guessing at a knob the error text never mentions.

(4) is strictly additive and should ship regardless of which of (1)-(3) wins.

## Acceptance

- [ ] `store repair-parked` completes on a store of at least this size with NO
      env override — measured, not argued.
- [ ] An over-limit failure names the env knob in its message.
- [ ] `threadCount`'s "mirrors memoryLimit" comment is either made true or
      corrected.
