---
trdd-id: KB17X5G2
title: The RAM spool still loses raw bodies under a subagent burst — capacity and reclaim throughput
column: todo
created: 2026-08-07T04:28:24+0200
updated: 2026-08-07T04:28:24+0200
current-owner: main
task-type: infra
severity: high
---

# The RAM spool still loses raw bodies under a subagent burst — capacity and reclaim throughput

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-07

Not started. Discovered while verifying `65207f4` (the reclaim fix). **`65207f4` is NOT in
question — it works, and this card exists only because fixing it revealed the next constraint.**

**NEXT ACTION:** decide between the two levers under *Options* — they are not equivalent and the
cheap one may be enough. Do NOT resize the RAM disk while it holds un-ingested bodies (that
destroys them).

## What was proven, and what it exposed

`65207f4` made already-durable bodies reclaimable. First completed pass after deploying it:

```
bodies → store: ingested 0, reclaimed 1906 file(s) (1906 already durable)
                (1.00GB read → 0.0MB new spans) [spool] [throttled — more next pass]
```

Every one of those 1,906 files was in the class that could **never** be reclaimed before, and the
line printed at all only because the same commit stopped gating the report on `ingested > 0`.

But during that verification a single background subagent (209,491 tokens, 14 tool uses, ~2 min)
refilled the spool from 4,576 files / 162 MB free to 4,905 files / **1.4 MB free — 100%**. At 100%
the spool cannot accept a write, so raw bodies were dropped, which is the exact failure this whole
line of work exists to prevent.

Measured either side of that burst:

| window | deleted | arrived | spool |
|---|---|---|---|
| steady state | 87 / 90 s | 1 / 90 s | 100% → 97%, 63 MB free |
| subagent burst | — | ~330 files in ~2 min | 93% → 100%, 1.4 MB free |

So steady-state drain beats steady-state arrival by ~87×, and a burst beats the drain outright.
The system self-heals afterwards; it just loses whatever arrived while full.

## Why it is not simply "the spool is too small"

Reclaim throughput is ~1 file/s because every delete is gated on reconstructing the body from
DuckDB and proving it byte-identical (plus its `(src_name, capture-ts)` row). That gate is
correct and must not be weakened — it is the only thing standing between a reclaim and silent
data loss. So capacity and throughput trade off against each other and both are on the table.

## Options (pick deliberately; they are not equivalent)

1. **Grow the spool** (`hdiutil` size). Cheapest and most direct — a 4 GB spool absorbs a burst
   this size with room to spare. **Precondition: the spool must be fully drained first**, because
   resizing detaches the RAM disk and everything on it is gone. Costs RAM that is otherwise free.
2. **Raise reclaim throughput.** Batch the verify: one DuckDB round trip per batch instead of two
   queries per file. Keeps the gate intact (same proof, fewer round trips) and helps every drain
   target, but it is a real change to `verifyBodyInStore`'s shape.
3. **Back-pressure instead of loss.** When the spool is over cap, spill new bodies to the legacy
   SSD dir (already drain target #2) rather than failing the write. Trades a bounded amount of SSD
   writing for never losing a body — which is the priority the owner has stated repeatedly.

Option 3 is the only one that makes loss impossible rather than merely unlikely, so it should be
weighed even if 1 is done first.

## Verification

Reproduce the burst deliberately: drain the spool, note free bytes, spawn a subagent of comparable
size, and assert the spool never reaches 0 free and that the count of captured bodies matches the
count of API calls made. A fix that only makes the window smaller must be described as that, not
as elimination.

## Notes and lessons learned
