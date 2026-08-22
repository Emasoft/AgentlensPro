---
trdd-id: 8TM7I49X
title: 1045 already-durable legacy body files are permanently parked in the Rust pass stranded set
column: todo
created: 2026-08-22T21:12:33+0200
updated: 2026-08-22T21:50:00+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [bodies, ingest, retention, silent-failure]
approval-tier: 0
relevant-files: [standalone/server.ts, src/store/ingestPass.ts, src/rustStorePass.ts, rust-core/crates/agentlens-store/src/pass.rs]
relevant-rules: []
created-by: TRDD-0SA5QZTG
---

# 1045 already-durable body files are parked forever, and nothing reports it

*(Filed as "the legacy bodies dir is a drain target that never drains" — the symptom. The cause
was found the same evening and the title now names it; the symptom narrative below is unchanged.)*

Split out of TRDD-0SA5QZTG, which asked "why is the newest archive index 2026-07-14?". That
question has an innocent answer (the `.wad` archiver was retired — see that card). Answering it
surfaced this, which is not innocent, and 0SA5QZTG's own lesson is *do not conflate the two
failures* — hence a separate card.

## Symptom (MEASURED first-hand 2026-08-22, not inferred)

`~/.agentlens/otel-bodies` holds **1045 files / 317.6 MB** (540 `.request.json`, 505
`.response.json`, zero non-body entries). **Every one is 96–147 h old.** The ingest age gate is
`bodiesMaxAgeHours` = **72 h**, so all 1045 are past it.

The dir IS a drain target on this server: capture is on, `SPOOL_MODE` is true, and
`drainTargets` (`standalone/server.ts:580-586`) is `[spool, legacy]` — the legacy dir is drained
explicitly so "leftovers from pre-spool / stale sessions are still reclaimed". The pass runs every
**60 s** in spool mode (`server.ts:852`).

Sampled across two full pass intervals while capture was live:

```
21:10:22  legacy=1045  spool=835
21:11:32  legacy=1045  spool=875     <- one full pass interval later
21:12:42  legacy=1045  spool=926     <- two
```

Legacy is **static to the file**; the spool is moving. So this is not "the whole pass is dead" —
it is the legacy target specifically. (The spool GROWING is not itself evidence the drain works
there — capture simply outruns it mid-session. The evidence that separates the two targets is
that one number moves and the other does not, on the same clock.)

**Corroborated from the server's own log — but read it correctly, because the obvious reading is
wrong.** `~/.agentlens/server.log` carries **278** `bodies → store: ingested N, reclaimed M`
lines, most recent today, with 1619 / 944 / 831 files reclaimed in recent passes. So the
machinery, the store, the delete gate and the flock all work; something is definitely being
reclaimed.

**What the `[spool]` tag on those lines does NOT mean.** Every line carries ` [spool]`, and the
first draft of this card read that as "every reclaim came from the spool target, so the legacy
target has never contributed". **That inference is invalid.** The tag is
`${SPOOL_MODE ? ' [spool]' : ''}` (`standalone/server.ts:747`) — a per-SERVER-MODE flag — and the
`console.log` sits **outside** the `for (const target of drainTargets)` loop, printing counters
summed across both targets (`server.ts:710`). One line per PASS, not per target. **The log cannot
attribute a reclaim to a target at all**, so "not one line is untagged" says nothing whatsoever.

**What actually separates the two targets, then:**

- the file-count sampling above — legacy static at 1045 while the pass demonstrably ran. This is
  the direct evidence and it is sufficient on its own;
- each logged pass reports **0.50 GB read** (the per-pass throttle, saturated). Legacy holds
  **317.6 MB in total**, so a 0.50 GB pass cannot be legacy-only — it is at minimum mostly spool.

Both are about the CORPUS, not about a log tag. Keeping the distinction is the point: this card's
parent chain has now produced four wrong inferences about this subsystem, and three of them came
from reading a status string as if it were a measurement.

## Why it is not visible

A pass that ingests 0 and deletes 0 **logs nothing** — the log line is gated on
`ingested > 0 || deleted > 0 || purged.removed.length > 0` (`server.ts:741`). That gate is
correct on its own terms (it exists so a quiet pass is not noise), but it means a target that
does nothing FOREVER is indistinguishable from a target with nothing to do. `server.log` since
the 20:57 restart carries no bodies line at all, no `PARKED` warning, and no flock-skip line.

`server status` says `bodies: ... (live kept 0.69GB)` — the 317 MB of stuck legacy files are
inside that number, described as "kept", which reads as a policy decision rather than a stall.

## ROOT CAUSE — FOUND 2026-08-22T21:45, exact and not inferred

**Every one of the 1045 files is permanently PARKED in the Rust pass's persisted stranded set.**
The counts are not "consistent with" the hypothesis; they are identical:

```
strandedNames          = 1045
legacy files           = 1045   of which stranded = 1045
spool  files           =  720   of which stranded =    0
stranded NOT in legacy =    0
skipNames              = 104314 — and all 1045 legacy files are in it too
```

Read from `~/.agentlens/store/.pass-state.json`. The stranded set **is** the legacy residue, to
the file. And because all 1045 are also in `skipNames`, **the store already holds their bytes**:
this is 317.6 MB of proven-durable data pinned on disk with no path to reclamation.

### The mechanism, at file:line

1. **The park.** `rust-core/crates/agentlens-store/src/pass.rs:386-391` — a body whose BYTES
   verify but whose stored `ts` row disagrees with capture time is parked:
   *"The ts-only livelock: bytes proven, row ts wrong — park it; re-ingest can never repair that
   row."* Correct as a livelock fix (TRDD-P8JGIEOG); re-ingesting cannot change the row.
2. **The park is permanent for a durable target.** `pass.rs:420-436`:

   ```rust
   if stranded_names.contains(&f.name) {
       if let Some(dest) = &opts.relocate_stranded_to { …relocate… }
       continue;          // no dest ⇒ nothing happens, this pass and every future pass
   }
   ```

   and `standalone/server.ts:702` passes
   `relocateStrandedTo: target.durable ? undefined : LEGACY_BODIES_DIR`. The legacy dir IS the
   durable target, so its dest is `None` — the spool's escape hatch (move the parked file to
   durable storage and free the RAM) has no counterpart here, by deliberate design: *"durable→
   durable relocation is churn, the park alone is correct there."*
3. **The state SURVIVES RESTARTS.** `pass.rs:94 save_pass_state` writes `.pass-state.json`. This
   is the difference that made the symptom invisible for days — and the thing I got wrong below.

### Correction to my own reasoning (candidate 2, dismissed on a proxy read)

Candidate 2 below argued the park was unlikely because `ingestStrandedNames` is an in-memory
`Set` (`standalone/server.ts:616`) emptied by the 20:57 restart. **That is the TypeScript
engine's set, and this server does not run the TypeScript engine.** `~/.agentlens/bin/alstore`
exists, so `alstoreBin()` opts in (`src/rustStorePass.ts:33-41`) and every pass goes through the
Rust binary, whose stranded set is a FILE. I checked the state of the engine that is not running
— the same class of error as reading the wrong directory, one card earlier.

The absent `PARKED` warning I cited as corroboration is explained too: the warning fires on
`r.strandedTs.length`, which counts files parked **during this pass**. A file parked days ago is
silently `continue`d and never re-reported. Silence meant "already parked", not "not parked".

### What this makes the defect

Not "a pass that fails to run" — a pass that runs correctly and has **no recovery path for a
park**. The set only grows: nothing re-examines a parked file, nothing repairs the `ts` row it is
parked for, and for a durable target nothing moves it out of the way. A monotonic set of
permanently-pinned files with no operator-visible surface is the shape of the bug.

## Remedies — a DECISION is needed, and the choice is not obvious

Ranked by my reading; box 2 stays open until one is picked.

1. **Repair the `ts` row, then unpark.** Addresses the actual defect. The park comment says
   *"re-ingest can never repair that row"* — true of re-ingest, not of a targeted UPDATE of the
   capture-ts column. Needs care: capture-ts is the provenance time-window scans rely on, so the
   repair must source it from the file's own mtime (the same value the pass compares against).
2. **Delete a parked file whose BYTES are proven.** Cheapest reclaim, and defensible — the delete
   gate's contract is "prove reconstruction, then unlink", which these already satisfy. But it
   destroys the only remaining source for the ts row, so it forecloses remedy 1 forever. **Do not
   do this before 1 is ruled out** (RULE 0 shape: it is unrecoverable).
3. **Relocate to a quarantine subdir** (`otel-bodies-stranded/`). Stops the rescan, keeps the
   bytes, makes the problem visible in a directory listing. Weakest — it moves the pile.
4. **Document and accept.** Only honest if paired with a surface that reports the park count, or
   this recurs invisibly.

Whatever is chosen, **the park needs an operator surface** — a count in `server status` or
`/api/server-stats`. 1045 permanently-pinned files were invisible for days.

## What was NOT established at filing time — candidate causes (kept; #2 was right)

Listed so the next session does not re-derive them, and explicitly NOT ranked, because this
card's parent went wrong three times by picking a cause and asserting it:

1. **The Rust pass.** ✗ **CHECKED, and the age gate is NOT the divergence.**
   `rust-core/crates/agentlens-store/src/pass.rs:256,259` is
   `let cutoff = if opts.max_age_ms > 0 { now_ms - opts.max_age_ms } else { i64::MAX };` then
   `.filter(|f| f.mtime_ms < cutoff)` — semantically identical to `src/store/ingestPass.ts:224`.
   The instinct to look at the Rust engine first was right; the place to look was its
   **persisted** state, not its age arithmetic.
2. **The stranded-ts park.** ✓ **RIGHT — and dismissed on a proxy read.** The reasoning
   ("`ingestStrandedNames` is an in-memory `Set` (`server.ts:616`), so the 20:57 restart emptied
   it; and re-parking 1045 files would emit the `PARKED` warning, which is absent") checked the
   TypeScript engine while the Rust engine was running, and misread a per-pass counter as a
   per-file one. Both halves wrong, same conclusion twice. See the root-cause section.
3. **The flock.** ✗ Not it. `r === null` logs its own skip line and none appears.
4. **`skipNames` filtering the reclaim.** ✗ Not it — and the Rust engine is correct here.
   `pass.rs:437-441` sends a skip-named file *straight to the gate* with `durable: true` rather
   than excluding it from the pass, exactly as `ingestPass.ts:225-230` prescribes. The park at
   `:420` is a separate branch that `continue`s BEFORE that one, which is why the same 1045 names
   sit in both sets while only the park has an effect.

## NEXT ACTION (runnable as written)

**Decide the remedy** (the four options above; 1 is my recommendation and 2 is irreversible).
The diagnosis is complete — what is missing is a decision, not a measurement.

To re-confirm the finding at any time, from a cold start:

```bash
node -e "
const fs=require('fs'),os=require('os');
const j=JSON.parse(fs.readFileSync(os.homedir()+'/.agentlens/store/.pass-state.json','utf8'));
const s=new Set(j.strandedNames);
const leg=fs.readdirSync(os.homedir()+'/.agentlens/otel-bodies').filter(f=>/\.(request|response)\.json$/.test(f));
console.log('stranded',s.size,'legacy',leg.length,'overlap',leg.filter(f=>s.has(f)).length);
"
```

## Acceptance

- [x] The cause is named with evidence at a `file:line`, not inferred from the symptom.
      `pass.rs:386-391` parks on a ts-row mismatch; `pass.rs:420-436` `continue`s a parked file
      forever when `relocate_stranded_to` is `None`; `server.ts:702` passes `undefined` for the
      durable target; `pass.rs:94` persists the set across restarts. Counts are exact (1045 =
      1045, overlap 1045, spool 0).
- [ ] The 1045 files either drain (verified: count falls, store row count rises, bytes
      reconstruct byte-identically) or the reason they must be kept is recorded IN THE CODE, not
      only here. **Blocked on the remedy decision above.**
- [ ] The park has an operator surface — a parked-file count in `server status` /
      `/api/server-stats`. 1045 permanently-pinned files were invisible for days, and the
      per-pass `PARKED` warning cannot show them because it only counts files parked *this* pass.
      Whatever is added must not turn every idle tick into a log line — a warning nobody can
      silence is a warning everybody filters.
- [ ] ~~If the cause is a TS/Rust policy divergence, a test pins the two engines to the same age
      gate~~ — **withdrawn: not the cause.** The age gates are semantically identical
      (`pass.rs:256` vs `ingestPass.ts:224`). The divergence that mattered is that the Rust
      stranded set is PERSISTED and the TS one is in-memory, which is a deliberate design
      difference, not a drift a parity test should fail on.

## Notes and lessons learned

[^1]: [id: quiet-pass-hides-stuck-target status: active keywords: "nothing in the log" "pass runs
    but does nothing" "files past retention still on disk" "live kept" idle vs stuck, ocd:
    2026-08-22 lmd: 2026-08-22] DO NOT gate a periodic task's ONLY log line on "it did something",
    BECAUSE a target that can never do anything then produces exactly the same output as a target
    with nothing to do — and the stuck one is invisible for as long as it stays stuck (measured:
    317 MB, 1045 files, 4+ days). DO make the two states distinguishable without making the idle
    case noisy: report the backlog a pass DECLINED to act on, not just the work it did.

[^2]: [id: check-the-engine-that-is-running status: active keywords: "in-memory set" "restart
    clears it" TS vs Rust engine opted in persisted state stranded park wrong engine, ocd:
    2026-08-22 lmd: 2026-08-22] DO NOT reason about a subsystem's state from the implementation
    you happen to be reading, BECAUSE this project ships TWO engines for the same pass and the
    running one is selected at runtime by the mere PRESENCE of a binary
    (`alstoreBin()`, `src/rustStorePass.ts:33-41` — `~/.agentlens/bin/alstore` existing IS the
    opt-in, with no env var and no log line to announce it). Here the TS stranded set is in-memory
    and dies with the process while the Rust one is a FILE that outlives every restart, so
    "a restart emptied it" was true of the engine that was not running and dismissed the correct
    cause. DO establish WHICH engine executes before reading its state — one `ls ~/.agentlens/bin`
    would have done it.

[^3]: [id: per-pass-counter-is-not-a-population status: active keywords: "no PARKED warning" "the
    log is silent" absent warning means not parked backlog vs event, ocd: 2026-08-22 lmd:
    2026-08-22] DO NOT read the absence of an EVENT log as the absence of a STATE, BECAUSE the
    `PARKED` warning fires on `r.strandedTs.length` — files parked *during this pass* — so 1045
    already-parked files produce silence forever, and silence meant "already parked", the exact
    opposite of the "not parked" it was read as. DO ask whether a log reports an event or a
    population before inferring a population from it; a monotonic set needs a gauge, not an event.
