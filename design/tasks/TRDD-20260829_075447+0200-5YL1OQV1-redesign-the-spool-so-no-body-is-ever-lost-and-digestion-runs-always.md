---
trdd-id: 5YL1OQV1
title: Redesign the spool so no body is ever lost and digestion runs continuously in the background
column: design
created: 2026-08-29T07:54:47+0200
updated: 2026-08-29T07:54:47+0200
current-owner: claude-agentlenspro
task-type: refactor
project-id: agentlenspro
parent-trdd: DMWOBWFH
npt: [ZW4APOPI]
blocked-by: [ZW4APOPI]
---

# Redesign the spool — no loss, ever; continuous background digestion

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**OWNER DIRECTIVE (verbatim, 2026-08-29):** *"you need to redesign the spool system. its clearly
flawed. no data must ever be lost! And the digestion must proceed in background at all times so
after a while, if the telemetry stream slow down, the spool is emptied."*

Two requirements, and they are separate:
1. **No loss, ever** — a hard durability guarantee, not a best effort.
2. **Digestion always running in the background** — so a lull in telemetry drains the backlog,
   rather than a fixed timer letting it accumulate between passes.

**PRECIPITATING INCIDENT — TRDD-ZW4APOPI, resolved manually today.** The 2 GB RAM-disk spool sat
100% full ~18 h; **117 of 122 request bodies since the fill were written as ZERO BYTES**, size-
dependent (1 KB responses fit, 867 KB requests did not). Recovered by hand with repeated
`alstore pass ~/.agentlens/store /Volumes/AgentLensSpool/otel-bodies` — 4,154 bodies ingested,
0 failed, 0 stranded, spool back to 1%. A full copy was taken first to
`~/.agentlens/spool-backup-20260829_075138+0200` (4,271 files) so the reclaiming pass could not
lose anything. (**"byte-identical" was overclaimed** in the first revision: file count and `du -sk`
totals matched, which is not a checksum — `du` reports allocated blocks, so on one filesystem it is
nearly a tautology. `cp -a` is very likely exact; it was not proven.) **That was a manual recovery
of a symptom; this card is the cause.**

## The constraint that makes this hard — state it before proposing anything

**The producer is EXTERNAL and cannot be throttled.** Claude Code writes the bodies itself; nothing
in this repo is in that write path (verified: every `.request.json` reference under `src/` and
`rust-core/` is a reader). So there is no backpressure channel and no way to make the producer wait.

**But the producer is UNTHROTTLEABLE, not UNBOUNDED — and that distinction sets the architecture.**
An earlier revision of this card said no-loss "is NOT achievable by draining faster", full stop.
That is wrong, and wrong in the direction that would have built the wrong system. The arrival rate
is capped by **API round-trip latency**: one request body per API call, and a call cannot complete
faster than its round trip. So the ceiling is roughly `N_sessions × (1 / RTT)` bodies/sec.

Measured inputs, and **both must be measurements of the BODIES path — do not borrow a span number**:

- **Arrival — a LOWER BOUND, not a rate.** `spoolBackpressure.ts` recorded 162 MB → 1.4 MB free in
  ~2 min from one subagent ≈ 1.33 MB/s. That is *net accumulation*: gross arrival = net + whatever
  drained concurrently, so true arrival is **≥ 1.33 MB/s**. Understating the numerator flatters the
  headroom conclusion, so size the drain against a **multiple** of it, never against it.
- **Drain — from today's actual recovery, on the actual path**: ~536 MB in one pass and the full
  ~2 GB across ~5 passes in ~2 min of wall clock ⇒ **order 10-20 MB/s**.

**An earlier revision cited the 949 req/s OTLP ingest bench as the drain rate. That was a category
error** — a different subsystem doing different work per item (span parse + append, vs read an
867 KB file, chunk, hash, write chunks, update the index, fsync, delete). Same family as the 400× →
36× → withdrawn headroom mistakes earlier in this work; the third instance, which is why it is
called out rather than quietly fixed. The conclusion survives on the real number: ~10-20 MB/s beats
1.33 MB/s per session by roughly 10×.

**Per-session is also the wrong sizing unit.** One subagent produced that figure, and body size
scales with conversation length — a long-context session emits far larger requests at similar
cadence. Size against aggregate MB/s measured at the spool, or bytes/s/session at the p95 of body
size.

**So the primary guarantee is a continuous drain sized against a measured worst-case arrival rate,
and spill-to-SSD is the BACKSTOP** for when that assumption is violated — a drain stalled on store
contention, a disk hiccup, or an N far above provisioning. Building spill as *the* architecture
would also mask a drain that is simply mis-sized.

**THE NUMBER THIS CARD STILL LACKS, and it decides the design:** worst-case bodies/sec/session ×
max expected concurrent sessions, versus sustained drain bytes/sec. Measure it before building
either mechanism.

**Second-order constraint:** the spool is a **RAM disk**, deliberately `durable: false`. A reboot
takes everything still in it, so "no loss" also implies bounding how long a body may sit there —
which is an argument for continuous digestion independent of the fill level.

## Known facts the design must respect

- `bodies_pass` (`chores.rs:208`) drains only `data_dir.join("otel-bodies")` — the legacy SSD dir,
  never the configured spool. This is the ZW4APOPI hole and it is still open in code.
- Drain interval is hardcoded **1 h** (`chores.rs:393-396`). The TS used
  `SPOOL_MODE ? 60_000 : 3600e3` (`server.ts:969`) — 60 s in spool mode. An hourly timer cannot
  satisfy "digestion at all times" and cannot keep a 2 GB ramdisk from filling between passes:
  `spoolBackpressure.ts` measured 162 MB → 1.4 MB free in **~2 minutes** from a single background
  subagent.
- `alstore pass` is **throttled by design** — it returns `{ingested, deleted, bytesFreed, failed,
  strandedTs, throttled}` and must be re-invoked until `throttled:false`. A single call per tick is
  not a drain; today's recovery took repeated passes.
- Exactly one pass runs machine-wide: exclusive `flock` on `<store>/.pass.lock`
  (`agentlens-store/src/pass.rs:47-61`), chore returns immediately on `Busy`. Any "continuous
  worker" design must live with that, not fight it.
- The resolver for "all body dirs, spool first" already exists:
  `burn::guard::resolve_bodies_read_scope` (`guard.rs:489`) / `bodies_dir_candidates` (`:440`).
  It supplies **no per-dir cap and no `durable` flag** — the TS distinguished both — so the port
  must add them rather than treat every dir alike.
- `--relocate-to DIR` appears in alstore's usage string; **implementation NOT verified** (a grep for
  rename/copy/move in its source found nothing). Do not build on it without reading it.

## Plan — ship the hole-closing part first, then the guarantee

1. **Close the loss hole — OWNED BY TRDD-ZW4APOPI, not duplicated here.** `bodies_pass` iterates
   `resolve_bodies_read_scope` (per-dir cap + `durable`), interval to 60 s in spool mode. Blocked
   only on the rc3 agent's `rust-core/` tree landing. This card does not restate its acceptance;
   two cards carrying the same checkbox is how work gets done twice or not at all. **5YL1OQV1
   starts where ZW4APOPI ends** — treat ZW4APOPI as an NPT.
2. **Continuous digestion**: replace the fixed tick with a loop that keeps passing while
   `throttled:true` and backs off only when the spool is actually empty.
3. **The durability guarantee**: the spill-to-SSD (or equivalent) design, pending the advisor
   verdict recorded below.
4. **Make the failure visible**: `dropped_on_failure` and the spool's own free-space are currently
   unobservable — `/api/server-stats` reports `bodies.spool` as a hardcoded `Value::Null` stub
   (`server_stats.rs:365-367`). A guarantee nobody can check is not a guarantee.

## Advisor verdict

**NOT OBTAINED — Fable exhausted its token window on 2026-08-29 and the consult was killed
mid-flight.** Per the advisor rule, proceeding with this recorded explicitly rather than implying a
verdict exists. **Re-consult before implementing step 3 (the durability mechanism)** — steps 1 and 2
are hole-closing and rate-sizing, and do not need it.

## `alstore pass` reports total success over destroyed bodies — a second observability hole

The recovery pass reported `ingested:4154, failed:[], strandedTs:[]` for a directory that contained
**117 zero-byte corpses**. The arithmetic reconciles exactly (4,271 − 4,154 = 117), so the pass
processed every non-empty file and skipped every empty one — defensible in itself, since an empty
file has no content to ingest and so is neither `failed` (nothing was attempted) nor `stranded`
(nothing to strand). **But it means a drain can encounter 117 destroyed bodies and report total
success.** A zero-length body is the on-disk signature of a prior full-spool loss and the only
forensic trace that the loss ever happened. Same class as `dropped_on_failure` being written and
never read (ZW4APOPI). Surface it as a distinct count.

## Acceptance

- [ ] the arrival-vs-drain rate measurement above is taken and recorded, BEFORE either mechanism
- [ ] a burst larger than the spool's free space loses **zero** bodies (test: write past the
      high-water mark, assert every body is later present in the store)
- [ ] a zero-length body is surfaced as its own count, never folded into silent success
- [ ] with the producer stopped, the spool drains to empty without operator action
- [ ] the spool's fill level and any drop counter are exposed in `/api/server-stats` and non-stubbed
- [ ] a reboot-while-full scenario has a stated, tested outcome rather than an assumed one

## Notes and lessons learned

The manual recovery worked and the ingest path is sound — but note HOW that was established, because
the first version of this sentence cited `alstore pass`'s own `0 failed, 0 stranded`, which is the
deleting tool grading its own homework. The originals had already been deleted on the strength of
it. What actually proves it is a round-trip: `alstore verify <store> <name> <file>` against the
SSD backup returned `ok:true` for 58/58 sampled bodies including the largest (2.06 MB). Audit the
step that can silently discard, not only the step that can corrupt — the lock was checked first
because corruption is scarier, while discard was the likelier failure.

**And `verify` was itself checked, because a verb named "verify" beside one named "reconstruct"
could plausibly have been an index-existence test.** It is not: `verify_bodies_in_store_cached`
(`agentlens-store/src/lib.rs:517`) calls `reconstruct_chunk` and fails with
`"reconstruction != source bytes"` on mismatch — a genuine byte-for-byte rebuild out of the store,
compared against the source file. It *requires* the original file precisely because it compares
against it, so needing that argument is not evidence of an index-only check. **A review argued the
opposite from the three-verb usage string alone and was wrong** — worth recording, because reading
the implementation beat reasoning about the CLI surface, which is the same proxy-for-the-thing
failure in the other direction.

**Caveat kept honest: 58 of 4,154 is a 1.4% sample** — enough for "the ingest path is sound" (~95%
confidence the failure rate is under ~5%), NOT for "no body was lost", which is a claim about all
4,154. The backup is still on SSD, so the strong claim is a minutes-long loop away if wanted.
`bytesStored`/`bytesIn` dedup theorising was **dropped from this card**: nothing distinguishes dedup
from a new-chunks-only delta without reading what the field counts, so it was worth zero as evidence
either way, and the round-trip makes it moot.

**117 bodies are permanently gone.** They were destroyed at write time, hours before this session's
recovery began — nothing here lost them and nothing could have recovered them. The backup preserves
that loss, it does not repair it; it exists so the *reclaiming pass* could not add to it. Say this
plainly rather than letting "recovered, 0 failed" imply the incident was made whole.

The defect was never in the digestion: nothing pointed it at the spool, and the timer was an order
of magnitude too slow for the buffer it guarded.
