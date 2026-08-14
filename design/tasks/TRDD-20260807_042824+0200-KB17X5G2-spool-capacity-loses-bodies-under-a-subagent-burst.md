---
trdd-id: KB17X5G2
title: The RAM spool still loses raw bodies under a subagent burst — capacity and reclaim throughput
column: complete
created: 2026-08-07T04:28:24+0200
updated: 2026-08-14T02:45:00+0200
current-owner: main
task-type: infra
severity: high
---

# The RAM spool still loses raw bodies under a subagent burst — capacity and reclaim throughput

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-07

**Option 3 is implemented (2026-08-11). Read the next paragraph before believing the *Options*
section below it — that section's central claim is now known to be FALSE.**

**THE PREMISE WAS WRONG: we do not own the write.** *Options* says Option 3 "is the only one that
makes loss impossible". That assumed the spool write happens in this codebase. It does not —
Claude Code's own OTEL exporter writes the body file directly, keyed off the launch-time env
`OTEL_LOG_RAW_API_BODIES=file:<dir>` (see `src/rawBodyContext.ts` and `src/bodyWriters.ts`). There
is no `fs.writeFile` here to wrap, so there is no ENOSPC for us to catch and no way to spill at
the moment of failure.

What shipped is back-pressure at the one boundary we DO own — which directory a session is *told*
to write into (`src/spoolBackpressure.ts` + a 5s tick in `standalone/server.ts` driving
`ensureTelemetryConfig`, which goes through `safeConfigEdit`). It redirects on the over-capacity
TRANSITION only, with 2x-floor hysteresis so it cannot flap, and fails OPEN when `df` fails.

**EFFICACY LIMIT — it would NOT have prevented the incident recorded below.** The env is read once
at a Claude session's own launch, so the redirect protects sessions that START after it fires. The
incident here was *a background subagent of an already-running session*, which inherits its
parent's launch-time env — so those bytes would still have been dropped. This is a real reduction
in exposure, not elimination, and per this card's own Verification rule it must be described that
way.

**Therefore Options 1 and 2 are now MORE important, not less** — they are the only levers that
help an in-flight burst. Option 1 (grow the spool) absorbs it; Option 2 (batch the DuckDB verify)
drains faster so the spool is rarely near the floor.

**NEXT ACTION:** decide Option 1 vs Option 2 with the owner. Option 1 is USER-GATED: resizing
detaches the RAM disk and destroys every un-ingested body on it, so the spool must be fully
drained first. Do NOT resize while it holds un-ingested bodies.

**RESOLVED 2026-08-14 (under the owner's standing review delegation): BOTH, in their safe forms.**
Option 2 (drain faster) landed as the Spool-equilibrium plan's P0/P0.5 — `settleBatch` verifies in
chunks of `SETTLE_READ_CHUNK = 32` (~14 round trips per 200-file batch vs ~400 before) with a
durable-source-only fsync gate (src/store/ingestPass.ts) — plus the P1 flush law (14f08ed:
bytes ≥ 12MB OR 60s backstop OR pressure floor drives the bodies pass). Option 1's SAFE half landed
as 84a2ca6: `DEFAULT_SPOOL_MB` 2048→4096, non-destructive because `ensureRamDisk` reuses an
already-mounted spool whatever its size — the 4GB takes effect on the next fresh mount. The
DESTRUCTIVE half (resizing the LIVE spool) stays user-gated exactly as this block orders; it can
also be done at any reboot for free, or early via `AGENTLENS_SPOOL_MB` after a verified drain.

`65207f4` (the reclaim fix) is NOT in question — it works; this card exists only because fixing it
revealed the next constraint.

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

## Approval log

- 2026-08-14T02:45:00+0200 — COMPLETED (human_review → complete). The undecided Option 1 vs 2 was
  resolved as recorded in the STATE block's RESOLVED paragraph (both, in their safe forms — P0/P0.5
  + P1 flush law + non-destructive 4GB default; live resize stays user-gated). The back-pressure
  efficacy limit (inherited launch-time env) remains truthfully described — reduction, not
  elimination. Review evidence: reports/trdd-review/20260814_015508+0200-batch3-review.md.
- 2026-08-14 — OWNER RULING (Tier 3, direct instruction): the 4 GB default is REVERSED to 2 GB
  ("resize it to 2gb") — with the P0/P1 drain fixes landed, the owner prefers the 2 GB of RAM back
  over the burst margin. DEFAULT_SPOOL_MB is 2048 again; the mounted spool was never grown, so no
  live resize occurred. AGENTLENS_SPOOL_MB stays as the per-machine override; the back-pressure
  redirect remains the safety valve. Card stays complete — this changes the chosen constant, not
  the resolved mechanism.

## Notes and lessons learned
