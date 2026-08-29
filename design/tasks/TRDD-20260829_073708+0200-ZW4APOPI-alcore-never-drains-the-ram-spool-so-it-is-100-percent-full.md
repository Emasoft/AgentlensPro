---
trdd-id: ZW4APOPI
title: alcore never drains the RAM-disk spool so it is 100 percent full and capture is silently losing bodies
column: todo
created: 2026-08-29T07:37:08+0200
updated: 2026-08-29T07:37:08+0200
current-owner: claude-agentlenspro
task-type: bugfix
project-id: agentlenspro
parent-trdd: YU8QPU89
blocked-by: []
---

# alcore never drains the RAM spool — it is full, and capture is losing data now

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**This is the USER's own question — "enough to avoid filling the spool and using too much
memory" — and on this machine the answer today is NO. Measured first-hand, not inferred:**

```
$ df -k /Volumes/AgentLensSpool
/dev/disk28  2097152  2097152  0  100%  /Volumes/AgentLensSpool   ← zero bytes free
$ find /Volumes/AgentLensSpool/otel-bodies -maxdepth 1 -type f | wc -l   → 4271
$ find /Volumes/AgentLensSpool/otel-bodies -maxdepth 1 -type f -size 0 | wc -l  → 117
oldest queued: 2026-08-28 13:40  (~18 h)   newest: 2026-08-29 07:06, ZERO BYTES
```

**117 zero-byte files is live, ongoing, silent loss** — the producer is still writing, small
responses (~1 KB) still squeeze in, and larger request bodies truncate to 0. `src/spoolBackpressure.ts:1-4`
names this exact outcome: *"At 100% the spool cannot accept a write, so raw bodies are DROPPED —
silent data loss, the exact failure the whole capture feature exists to prevent."*

**ROOT CAUSE (verified in code, both halves).** A 2 GB RAM disk is simultaneously "the spool" and
"memory", and its fill rate is governed by ingestion speed — so it is the spool the USER means.
It has no drain under alcore:

- `chores.rs:208` — `bodies_pass` hardcodes `data_dir.join("otel-bodies")`, the LEGACY SSD dir.
- `standalone/server.ts:620-624` — the TS drained **two** dirs in `SPOOL_MODE`: the spool
  (`PRIMARY_BODIES_DIR`, `durable: false`) **and** the legacy dir.
- The gate was `OTLP_PORT === 4318`. The live process is
  `alcore serve … --otlp-port 4318 --ui-port 3000 --mcp-port 4316`.

`chores.rs:197-199` predicted this day **in writing**: *"the spool gate is `OTLP_PORT === 4318`,
which alcore is not (it binds 4319). **The day alcore takes 4318 this becomes wrong and the spool
dir must join the drain.**"* That day arrived; nothing re-read the comment. `/api/server-stats`
reports `bodies.spool: null` — alcore cannot even see it.

**THE FIX IS SMALL, AND THE RESOLVER ALREADY EXISTS — do not write a new one.**
`burn::guard::resolve_bodies_read_scope` (`guard.rs:489`) returns ALL readable candidate dirs, and
`bodies_dir_candidates` (`:440`) already orders **spool first** for exactly this class of bug
(TRDD-8N3KQW2R: a guard reading the empty legacy dir silently reports "no risk"). `bodies_pass`
should iterate that scope instead of hardcoding one dir. Carry over the TS's `durable` distinction:
the RAM spool is volatile by design, so it takes **no fsync barrier** (`server.ts:615-618`), and
its cap is `min(BODIES_MAX_BYTES, 70% of spool size)`, not the legacy cap.

**The drain IS the recovery.** Once it runs, the 4,154 non-empty bodies are ingested into the store
and their space reclaimed. **Do NOT delete spool files to free space** — that is the data the
feature exists to capture, and RULE 0 forbids it.

**NEXT ACTION:** blocked only on the rc3 agent (`aaa93e1d302fbdefb`) committing its `rust-core/`
tree; then edit `bodies_pass` to iterate `resolve_bodies_read_scope`. Verify by `df` going below
100% and the zero-byte count ceasing to grow.

## Second, separate regression — the hook-spool drain was never ported either

`hook_events.rs:10-11`, verbatim: *"NOT PORTED (each has its own TS subsystem, deferred): the
boot-time hook-spool drain"*. Live: `/api/server-stats` `hookEvents.spooled: 2397` and
`ls ~/.agentlens/hook-spool | wc -l` → **2400** (it grew 3 during this investigation). Under alcore
those events are written and never reingested, so the spool is monotonic. At the 20,000-file cap
`spoolHookEvent` starts **deleting the oldest** (`hookHandlers.ts:79-84`), and `:220-224` names what
goes first: *"the lifecycle events (StopFailure, PreCompact) that exist precisely because nothing
else records them."* Its own card is an NPT of this one if it does not fit here.

## What this corrects on TRDD-YU8QPU89

The spool reframing committed in `4a63fd6` is **right about the hook-spool and answers the wrong
one**. `forwardHookEvent` really does spool only on POST failure, so its p99-under-1 s framing
stands *for that spool* — but the p99 cannot observe any of the above. Keep the reframing, add this
beside it. Two further limits on the p99 as a sufficient answer (review F5): with the drain unported
the hook-spool is monotonic, so only a depth-over-time sample shows it; and a 50 ms p99 is perfectly
compatible with a spool quietly discarding lifecycle events at the cap. The honest minimum is the
p99 **plus** two depth samples (`hookEvents.spooled`, `df /Volumes/AgentLensSpool`) around the load
— still minutes, so the card's rejection of the 1-hour soak stands; only its claim of sufficiency
does not.

## Acceptance

- [ ] `bodies_pass` drains every dir in `resolve_bodies_read_scope`, spool first, spool without the
      fsync barrier and under the 70%-of-spool cap
- [ ] a test proves a body written to a configured spool dir is ingested and reclaimed (mutation-
      verified: reverting to the hardcoded dir fails it)
- [ ] on this machine `df /Volumes/AgentLensSpool` drops below 100% and the zero-byte file count
      stops growing
- [ ] `/api/server-stats` exposes the spool (today `bodies.spool: null`), so the next occurrence is
      visible instead of needing a `df`

## Notes and lessons learned

A comment that correctly predicts its own future breakage prevents nothing on its own — this one
named the exact trigger condition (`OTLP_PORT === 4318`) and was still read by no one on the day
the condition became true. The port move and the drain target are coupled facts; only an executable
check ties them together.
