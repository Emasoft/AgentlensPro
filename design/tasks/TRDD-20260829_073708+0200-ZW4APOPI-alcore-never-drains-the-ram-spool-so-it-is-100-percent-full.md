---
trdd-id: ZW4APOPI
title: alcore never drains the RAM-disk spool so it is 100 percent full and capture is silently losing bodies
column: dev
created: 2026-08-29T07:37:08+0200
updated: 2026-09-02T08:05:01+0200
current-owner: claude-agentlenspro
task-type: bugfix
project-id: agentlenspro
parent-trdd: YU8QPU89
blocked-by: []
---

# alcore never drains the RAM spool — it is full, and capture is losing data now

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

> **FIXED IN `58070386` — committed, NOT yet deployed.** `bodies_pass` now iterates
> `resolve_bodies_read_scope` (spool first), drains the spool at **age 0** unconditionally, and
> keeps passing until each dir reports empty (bounded `DRAIN_MAX_PASSES = 16`). Interval 1 h → 60 s
> when a spool is configured; `durable_source` per-dir so only the legacy dir takes the fsync
> barrier. Test `chores_bodies_spool_drain.rs` is mutation-verified.
>
> **The second defect would have made the first fix INERT, and only the test caught it:** defaults
> are `bodiesMaxAgeHours: 72` and `bodiesMaxGb: 8`, but the spool is a 2 GB RAM disk — it can never
> exceed an 8 GB cap, so the over-cap valve never fires for it and every body would have waited 72 h
> on a disk that fills in ~7 at the measured ~5 MB/min. Pointing the drain at the right directory
> was necessary and not sufficient.
>
> **Still running against the PUBLISHED global install**, so the spool is draining only by manual
> `alstore pass` (3 passes on 2026-08-29). Deploy = build + `agentlenspro server restart`.

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

**117 raw bodies have been silently lost to a full disk. The mechanism is settled; whether it is
still happening RIGHT NOW is NOT — see the sampling note below.**

The discriminating evidence is **size-dependent censoring by file kind**:

| kind | non-empty | ZERO bytes |
|---|---:|---:|
| `.request.json` (large — a whole conversation prefix) | 2,020 | **117** |
| `.response.json` (~1 KB) | 2,134 | **0** |

Every single truncation is on the large kind, against two near-equal populations. A create-then-write
race is **size-blind** and would censor both kinds roughly in proportion; a full disk is not. 117-to-0
is not a ratio chance produces.

**"Large" is measured, not assumed** (it was assumed for one revision, on a glance at three response
files):

| kind | min | median | max |
|---|---:|---:|---:|
| `.request.json` | 4,549 | **867,236** | 2,063,958 |
| `.response.json` | 829 | **1,092** | 20,290 |

A **794× median gap**, with the distributions essentially disjoint. On a disk with 0 bytes free a
~867 KB request cannot land while a ~1 KB response still slots into leftover slack — which is
precisely the observed pattern.

**This also refutes the competing "write-ORDER" explanation** (empties on requests because the
producer writes request-then-response, so calls in flight when the disk filled left a created-but-
unwritten request and no response). Two independent facts kill it: the disk filled **once**, yet the
117 empties are spread across **four separate hours** (48 / 8 / 19 / 42) — in-flight calls at one
instant cannot do that; and the files **pair 1:1**, 2,137 request files (2,020 + 117) against 2,134
responses, a gap of 3. If ordering were the cause, the truncated requests would have no responses and
the gap would be ~117. Instead every truncated request has its small response safely on disk — the
signature of size, not sequence.

The time distribution merely *corroborates*:

| hour | written non-empty | truncated to 0 |
|---|---:|---:|
| 08-28 13:00–16:00 | 3,372 | **0** |
| 08-28 17:00 | 708 | 48  ← the disk fills |
| 08-28 18:00 | 8 | 8 |
| 08-29 06:00–07:00 | 66 | **61** |

Zero zero-byte files across ~4,000 writes before the disk filled; **~48% of writes truncated in the
last active hour**. The buckets are arithmetically COMPLETE — 117 zero-byte + 4,154 non-empty =
4,271, the exact total file count — so nothing was silently dropped by the `stat` pass that built
them. (Worth stating: the "an artifact would spread evenly over 18 h" reasoning an earlier revision
used is close to circular, because a create/write race is expected to be near-zero in *any* healthy
hour. The kind-split above is the argument that actually discriminates; this table corroborates.)

`src/spoolBackpressure.ts:1-4` names this exact outcome: *"At 100% the spool cannot accept a write,
so raw bodies are DROPPED — silent data loss, the exact failure the whole capture feature exists to
prevent."*

**ONGOING — during every ACTIVE window, and the last one lost 100% of request bodies.** Per-hour,
by kind (verified GNU `stat`, see the tooling warning below):

| hour | request EMPTY | request ok | response ok |
|---|---:|---:|---:|
| 08-29 06:00 | 19 | 3 | 22 |
| 08-29 07:00 | **42** | **0** | 41 |

**This is also the direct refutation of the write-ORDER hypothesis, and it is cleaner than the
pairing argument below.** In the 07:00 hour the same calls wrote both kinds against the same full
disk: the request (first, ~867 KB) failed 42 times out of 42, and the response (second, ~1 KB)
written immediately afterwards succeeded 41 times. An order-dependent failure — "the first write
after the disk fills fails" — would have killed the second write too. It did not, every time. The
only variable that differs between the failing and succeeding write **within a single call** is
size.

**This corrects a retraction that was itself wrong.** A prior revision withdrew "ongoing" because
two counts 15 minutes apart (07:27, 07:42) both read 117 with nothing written since 07:06. That
observation was true and the inference from it was not: the window sampled was simply one in which
the producer made no calls. It had written 83 files in the preceding hour and lost every request
among them. The lesson is not "don't retract" — it is that a flat count over an idle window is no
more evidence of safety than a single snapshot was evidence of loss.

**The producer is Claude Code itself, not this repo.** No writer was FOUND here — every
`.request.json` / `.response.json` reference under `src/` and `rust-core/` that a literal-string
grep locates is a reader. That is an observation plus a positive account (it matches how
`--install-otel` wires capture), **not a proof of absence**: a writer composing the name by
concatenation would carry neither literal and the grep would miss it. Either way the consequence
holds — the producer cannot be throttled from inside AgentlensPro, so only the drain can keep up.

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
- **`OTLP_PORT === 4318` WAS NEVER THE SPOOL GATE — the comment was wrong when it was written, and
  two revisions of this card repeated it.** Verified at `standalone/server.ts:588-600`: `SPOOL_MODE`
  is set from `CAPTURE_ON && spoolDirConfigured(DATA_DIR)`. The port appears nowhere in it. So the
  `chores.rs:197-199` comment was not prescient — it named a trigger that never existed, and the
  drain gap did not begin the day alcore took 4318. It has been there since `bodies_pass` was
  written. Drop the "the day arrived" framing entirely; the defect is older and simpler than that
  story. The live process is `alcore serve … --otlp-port 4318 --ui-port 3000 --mcp-port 4316`, which
  matters only as *when the TS drain stopped running at all*.

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

**PRIORITY — does this still outrank the rate question now that "ongoing" is retracted? YES, and
not for the reason the first revision gave.** The retraction removes the urgency of *this minute*,
not the defect: the spool is at 0 bytes free and **nothing will ever reclaim it**, so every future
request body is lost on arrival, permanently, until the drain lands. Capture is not degraded, it is
non-functional for the large half — and per `CLAUDE.md` the captured raw body is the ground truth
behind `ctxmap` and `ctxvis`, the two things that answer "what is in the context" and "what does
this agent cost to keep running". A defect that silently zeroes their input outranks a throughput
measurement whose own denominators are still unsettled.

**⚠ TOOLING TRAP THAT ALMOST INVERTED THIS CARD'S CONCLUSION.** `find` on this machine is **`bfs`
4.1.1**, not GNU or BSD find. A `find … -newermt "2026-08-29 06:00"` pass reported **0 empty
requests and 64 non-empty ones** after the fill — the exact opposite of the truth — which would have
"proved" writes were all succeeding and killed this card. The verified GNU `stat -c '%y'` pass above
is the true reading, and the two disagreeing is what caught it. **Do not use `find -newermt` here;
bucket with `stat`.** Fifth member of this machine's PATH-shadowing class — see the LOCAL memory
note `find-on-path-is-bfs-not-gnu-find`, and its siblings for `stat`/`date`/`sample`.

**⚠ "BLOCKED" WAS FALSE — a recovery exists TODAY and needs no source change.** `alstore pass
<storeDir> <bodiesDir>` takes the bodies dir as a **positional argument**, defaults `max_age_ms` to
0 ("ingest regardless of age") and `durable_source` to false — exactly the spool's semantics
(`alstore.rs:6-8,31-32`). It ships in the same `bin-native/` as the running `alcore` and takes the
same `acquire_pass_lock`. So the card parked a live-data-loss finding behind an unrelated agent's
tree when a one-command drain was available the whole time.

**NOT RUN — it needs USER authorization.** A pass ingests each body into the store and then
DELETES it to reclaim space. The spool is untracked data outside the repo, so RULE 0 requires
explicit permission before any command that deletes it, even one whose whole purpose is a
preserving migration. `--no-delete` ingests without reclaiming, but leaves the disk full and the
loss continuing, so it is not a substitute. **Ask, then run.**

**NEXT ACTION (two independent tracks — the first is not blocked on the second):**
1. **Recovery:** get USER authorization, then `alstore pass ~/.agentlens/store
   /Volumes/AgentLensSpool/otel-bodies`. Reclaims ~2 GB and stops the loss immediately.
2. **The permanent fix** (needs the rc3 agent's `rust-core/` tree to land first): make
   `bodies_pass` iterate `resolve_bodies_read_scope`. **Also carry the drain INTERVAL** — it is
   hardcoded to 1 h (`chores.rs:393-396`) on the same false premise, while the TS used **60 s** in
   spool mode. A correct target dir on a 1-hour timer still lets a 2 GB RAM disk fill between
   passes, so the interval is part of the fix, not a follow-up. `resolve_bodies_read_scope` also
   supplies no per-dir cap or `durable` flag, which the TS drain distinguished — the port must add
   them rather than treat every dir alike.

**Verify by** `df` going below 100% AND a request body larger than the free space landing non-empty.
The zero-byte count going flat is NOT a pass on its own — it is flat right now with the bug fully
present, during an idle window.

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

- [x] `bodies_pass` drains every dir in `resolve_bodies_read_scope`, spool first, spool without the
      fsync barrier and under the 70%-of-spool cap — LIVE 2026-09-01: every pass logs
      "bodies pass: ingested N, deleted N, freed X across 2 dir(s)" on the alcore live server.
- [ ] a test proves a body written to a configured spool dir is ingested and reclaimed (mutation-
      verified: reverting to the hardcoded dir fails it)
- [x] on this machine `df /Volumes/AgentLensSpool` drops below 100% and the zero-byte file count
      stops growing — MEASURED 2026-09-01 22:00: 2% used (27M of 2.0G), zero-byte files = 0.
- [ ] `/api/server-stats` exposes the spool (today `bodies.spool: null`), so the next occurrence is
      visible instead of needing a `df`

## Notes and lessons learned

**A confident comment is not a source of truth, and this card believed one for three revisions.**
`chores.rs:197-199` states "the spool gate is `OTLP_PORT === 4318`". It is not, and never was —
`server.ts:588-600` gates `SPOOL_MODE` on `CAPTURE_ON && spoolDirConfigured`, with no port
anywhere. The comment reads as prescient, which is exactly why nobody checked it: a wrong fact that
*predicts its own breakage* is more persuasive than a plain wrong fact, and it seeded a whole false
narrative ("the day arrived") into this card twice. Verify a comment against the code it describes
before building on it, especially when it flatters the story you are already telling.

Two lessons from reviewing this card's own first revision, both the same shape — a PROXY read in
place of the thing:

1. **A count is not a mechanism, and neither is a distribution — the discriminator is.** "117
   zero-byte files" has innocent readings (create-then-fill, crash residue). The first fix reached
   for a time distribution and argued "an artifact would spread evenly over 18 h" — which is close
   to circular, since a create/write race is near-zero in any healthy hour, so "0 before" is exactly
   what the innocent explanation ALSO predicts. What actually settled it was finding the variable
   the two explanations disagree on: **size**. All 117 empties are the large `.request.json`, none
   are the ~1 KB `.response.json`, against near-equal populations. A race is size-blind; a full disk
   is not. Look for the axis on which the competing hypotheses make *different* predictions, not the
   one on which your favoured hypothesis looks good.
2. **A snapshot is not a rate.** "Currently dropping" was asserted from one `ls -lt` reading of the
   newest file. Two samples 15 min apart both read 117, with nothing written for 36 min — so the
   loss is real and past, not demonstrably live. One extra `wc -l` fifteen minutes later was the
   whole cost of not overstating it.
3. **"The resolver exists" is not "the resolver resolves."** The fix's whole viability rested on a
   `config.json` key that `spool_dir_configured` silently degrades to `None`. It was asserted in the
   committed card and verified afterwards. One `cat` before the claim, not after.
4. **One grep pattern is not an absence proof.** "No writer exists in this repo" came from grepping
   two literal filename suffixes; a writer building the name by concatenation carries neither. The
   conclusion is likely right, but it is an observation, and the card now says so.
