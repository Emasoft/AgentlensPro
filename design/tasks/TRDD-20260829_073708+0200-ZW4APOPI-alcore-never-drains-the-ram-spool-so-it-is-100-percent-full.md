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

**THIS DOES NOT ANSWER THE USER'S RATE QUESTION — read that before quoting this card.** The USER
asked whether ingestion is *fast enough* to avoid filling the spool. What is wrong here is that
**nothing drains the spool at all**, so it would fill at ANY ingestion rate, including zero. No
throughput improvement can fix an absent drain, and a working drain will not prove the rate is
sufficient. The rate question stays OPEN behind this one, on TRDD-YU8QPU89. (An earlier revision of
this card said "the USER's question, answered NO" — that was wrong, and the distinction changes both
the fix and the acceptance criterion.)

**What IS true, measured first-hand on this machine, not inferred:**

```
$ df -k /Volumes/AgentLensSpool
/dev/disk28  2097152  2097152  0  100%  /Volumes/AgentLensSpool   ← zero bytes free
$ find /Volumes/AgentLensSpool/otel-bodies -maxdepth 1 -type f | wc -l   → 4271
$ find /Volumes/AgentLensSpool/otel-bodies -maxdepth 1 -type f -size 0 | wc -l  → 117
oldest queued: 2026-08-28 13:40  (~18 h)   newest: 2026-08-29 07:06, ZERO BYTES
```

**117 zero-byte files is live, ongoing, silent loss.** The zero-byte count alone would be weak
evidence — it has innocent explanations (two-phase create-then-fill, crash residue). The
DISTRIBUTION is what settles it, and it is unambiguous:

| hour | written non-empty | truncated to 0 |
|---|---:|---:|
| 08-28 13:00–16:00 | 3,372 | **0** |
| 08-28 17:00 | 708 | 48  ← the disk fills |
| 08-28 18:00 | 8 | 8 |
| 08-29 06:00–07:00 | 66 | **61** |

Zero zero-byte files across ~4,000 writes before the disk filled; **~48% of writes lost in the
last two hours**. Small responses (~1 KB) still squeeze into the remaining slack, larger request
bodies do not. `src/spoolBackpressure.ts:1-4` names this exact outcome: *"At 100% the spool cannot
accept a write, so raw bodies are DROPPED — silent data loss, the exact failure the whole capture
feature exists to prevent."*

**The producer is Claude Code itself, not this repo** — every `.request.json` / `.response.json`
reference under `src/` and `rust-core/` is a READER (verified: no writer exists here). So the
producer cannot be stopped or fixed from inside AgentlensPro; only the drain can keep up with it.
That is also why the loss continues while alcore is up and healthy.

**ROOT CAUSE (verified in code, both halves).** A 2 GB RAM disk is simultaneously "the spool" and
"memory", and its fill rate is governed by ingestion speed — so it is the spool the USER means.
It has no drain under alcore:

- `chores.rs:208` — `bodies_pass` hardcodes `data_dir.join("otel-bodies")`, the LEGACY SSD dir,
  **unconditionally**. There is no port check and no spool gate anywhere in the Rust: the spool is
  undrained regardless of which port alcore binds. Do not go looking for a `4318` condition in
  `chores.rs` — there is none, and an earlier revision of this card implied there was.
- `standalone/server.ts:620-624` — the TS drained **two** dirs in `SPOOL_MODE`: the spool
  (`PRIMARY_BODIES_DIR`, `durable: false`) **and** the legacy dir. `SPOOL_MODE` was a condition on
  the **TS server's own** env, deciding whether *it* drained both.
- So `OTLP_PORT === 4318` is a **historical marker, not a trigger**: it is why the TS server is no
  longer the thing serving, and therefore why its two-dir drain stopped running. The live process is
  `alcore serve … --otlp-port 4318 --ui-port 3000 --mcp-port 4316`.

`chores.rs:197-199` predicted this day **in writing**: *"the spool gate is `OTLP_PORT === 4318`,
which alcore is not (it binds 4319). **The day alcore takes 4318 this becomes wrong and the spool
dir must join the drain.**"* That day arrived; nothing re-read the comment. `/api/server-stats`
reports `bodies.spool: null` — alcore cannot even see it.

**THE FIX IS SMALL, AND THE RESOLVER ALREADY EXISTS — do not write a new one.**
`burn::guard::resolve_bodies_read_scope` (`guard.rs:489`) returns ALL readable candidate dirs, and
`bodies_dir_candidates` (`:440`) already orders **spool first** for exactly this class of bug
(TRDD-8N3KQW2R: a guard reading the empty legacy dir silently reports "no risk"). `bodies_pass`
should iterate that scope instead of hardcoding one dir.

**VERIFIED that this actually reaches the spool on this machine** — the resolver reads
`capture.spoolDir` from `<dataDir>/config.json` via `spool_dir_configured` (`guard.rs:426-431`),
which swallows every error to `None`, so an absent or stale key would make the fix a no-op. It is
present and correct: `capture.spoolDir = /Volumes/AgentLensSpool/otel-bodies`, the full path, and
`bodies_dir_candidates` pushes it **verbatim** without re-joining `otel-bodies`. Candidates resolve
to `[spool, legacy]`, both existing. (Checked only after the first revision of this card had already
asserted the fix was small — the assertion happened to hold, but it was an assumption when written.) Carry over the TS's `durable` distinction:
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
named the exact condition (`OTLP_PORT === 4318`) and was still read by no one on the day it became
true. The port move and the drain target are coupled facts; only an executable check ties them
together.

Two lessons from reviewing this card's own first revision, both the same shape — a PROXY read in
place of the thing:

1. **A count is not a mechanism; a distribution is.** "117 zero-byte files" has innocent readings
   (two-phase create-then-fill, crash residue) and on its own proved nothing. What settled it was
   that **zero** appeared across ~4,000 writes before the disk filled and ~48% after — an artifact
   of the write pattern would be spread evenly over all 18 h, not correlated with the fill point.
   The reviewer's suggested settling command (grep `src/` for the writer) could not have worked:
   there is no writer in this repo to read. The distribution answered what reading the writer would
   have.
2. **"The resolver exists" is not "the resolver resolves."** The fix's whole viability rested on a
   `config.json` key that `spool_dir_configured` silently degrades to `None`. It was asserted in the
   committed card and verified afterwards. One `cat` before the claim, not after.
