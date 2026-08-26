---
trdd-id: IXVHM52P
title: The 8GB DuckDB ceiling OOMs a full-store validate — repair-parked fails out of the box
column: todo
created: 2026-08-26T04:25:32+0200
updated: 2026-08-26T04:34:15+0200
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
corruption).

A rerun with `AGENTLENS_DUCKDB_MEMORY_LIMIT=24GB` is **in progress and has not
completed**. What is measured so far: at 10m39s it is in the same verify leg at
13.4 GB RSS — past the 7.4 GiB watermark where the default run died, which is
evidence the raised ceiling is doing work, and NOT evidence that the repair
completes. (An earlier version of this card claimed the rerun "got past it" as
finished fact; it was not measured. Corrected by a review fork.)

## Why this is a defect, not a tuning preference

`DEFAULT_MEMORY_LIMIT = '8GB'` (`src/store/db.ts:63`) is a FIXED constant on a
machine with 64 GB, while its sibling `DEFAULT_THREADS` (`:68`) IS machine-scaled
(`availableParallelism() - 2`, floor 4). So the one operation that must validate
EVERY blob and EVERY body gets all the machine's cores and a fraction of its
memory, and `SET temp_directory = ''` (deliberate — "an over-limit query must
fail, not silently write gigabytes to the SSD") converts the overflow into a hard
failure rather than a slow one.

(An earlier version of this card blamed `threadCount`'s "mirrors memoryLimit"
comment as false. It is not: "mirrors" refers to the `env > option > default`
resolution cascade, which both functions genuinely share. The real asymmetry is
the DEFAULT, not the comment — corrected by a review fork.)

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
   the way V1 already does. Verified: `src/store/validate.ts:92-95` materializes
   every `body_id` into one array and then loops, while V1 scans in chunks —
   and V1's own comment says the corpus is larger than RAM and "a validator that
   OOMs is a validator that…", which is precisely what its V2 sibling then is.
   This is the root-cause remedy; (1) and (2) buy headroom around it.
4. At minimum: name `AGENTLENS_DUCKDB_MEMORY_LIMIT` in the failure message, so
   the operator is not left guessing at a knob the error text never mentions.

(4) is strictly additive and should ship regardless of which of (1)-(3) wins.

## Acceptance

- [ ] `store repair-parked` completes on a store of at least this size with NO
      env override — measured, not argued.
- [ ] An over-limit failure names the env knob in its message.
- [ ] `DEFAULT_MEMORY_LIMIT` either scales with the machine the way
      `DEFAULT_THREADS` already does, or its fixed-ness is justified in a comment
      that names the store size it is known to survive.
