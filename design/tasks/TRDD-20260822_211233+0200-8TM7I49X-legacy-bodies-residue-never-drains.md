---
trdd-id: 8TM7I49X
title: 1045 legacy body files sit 96-147h past the ingest age gate and never drain
column: todo
created: 2026-08-22T21:12:33+0200
updated: 2026-08-22T21:12:33+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [bodies, ingest, retention, silent-failure]
approval-tier: 0
relevant-files: [standalone/server.ts, src/store/ingestPass.ts, rust-core/src/store/pass.rs]
relevant-rules: []
created-by: TRDD-0SA5QZTG
---

# The legacy bodies dir is a drain target that never drains

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

**Corroborated from the server's own log, which is stronger than the sampling above.**
`~/.agentlens/server.log` carries **278** `bodies → store: ingested N, reclaimed M` lines — and
**every single one is tagged `[spool]`.** The tag is emitted from `SPOOL_MODE`, and the pass logs
one line per pass covering BOTH targets, so a legacy reclaim would appear in the same line's
counters. The machinery, the store, the delete gate and the flock all work; 1619, 944 and 831
files were reclaimed in recent passes. It is this one target that has never contributed.

This also means the search space is smaller than it looks: whatever is wrong is specific to a
target with `durable: true` and `relocateStrandedTo: undefined`, or to how the second iteration
of the `drainTargets` loop is reached, and NOT to ingestion, verification or deletion in general.

## Why it is not visible

A pass that ingests 0 and deletes 0 **logs nothing** — the log line is gated on
`ingested > 0 || deleted > 0 || purged.removed.length > 0` (`server.ts:741`). That gate is
correct on its own terms (it exists so a quiet pass is not noise), but it means a target that
does nothing FOREVER is indistinguishable from a target with nothing to do. `server.log` since
the 20:57 restart carries no bodies line at all, no `PARKED` warning, and no flock-skip line.

`server status` says `bodies: ... (live kept 0.69GB)` — the 317 MB of stuck legacy files are
inside that number, described as "kept", which reads as a policy decision rather than a stall.

## What is NOT established — candidate causes, none verified

Listed so the next session does not re-derive them, and explicitly NOT ranked, because this
card's parent went wrong three times by picking a cause and asserting it:

1. **The Rust pass.** The server runs `rustIngestPass` when `alstore` is present
   (`server.ts:681`), which takes neither `skipNames` nor `strandedNames`. Whether
   `rust-core/src/store/pass.rs` applies `maxAgeMs` with the same `f.mtime < cutoff` semantics as
   `src/store/ingestPass.ts:224` is unchecked. **This is the first thing to check** — the TS and
   Rust engines are supposed to be byte-identical in policy, and this is exactly where a
   divergence would hide.
2. **The stranded-ts park.** `ingestStrandedNames` is an in-memory `Set` (`server.ts:616`), so a
   restart empties it — and the server restarted at 20:57. Re-parking 1045 files would emit the
   `PARKED` warning, which is absent. Argues against, does not refute (the Rust path may park
   without that log).
3. **The flock.** `r === null` means another pass owns the store; it logs, and that line is
   absent.
4. **`skipNames` filtering the reclaim.** `ingestPass.ts:225-230` documents this exact bug
   ("stranded 3,615 bodies in a full 2 GB RAM spool") and states the skip belongs on the ingest,
   not the reclaim — so it is fixed in the TS. Unchecked in Rust.

## NEXT ACTION (runnable as written)

```bash
# Does the Rust pass see them at all? Run the pass by hand against the legacy dir.
alstore pass --help    # confirm the flag surface first; do NOT guess it
```

Then compare `rust-core/src/store/pass.rs` age-gate handling against
`src/store/ingestPass.ts:224` (`const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : Infinity`;
`bodyFiles(dir).filter(f => f.mtime < cutoff)`).

## Acceptance

- [ ] The cause is named with evidence at a `file:line`, not inferred from the symptom.
- [ ] The 1045 files either drain (verified: count falls, store row count rises, bytes
      reconstruct byte-identically) or the reason they must be kept is recorded IN THE CODE, not
      only here.
- [ ] A target that does nothing across many consecutive passes is no longer silent. The existing
      gate keeps a quiet pass quiet; the gap is that "quiet" and "stuck" print the same thing.
      Whatever is added must not turn every idle tick into a log line — a warning nobody can
      silence is a warning everybody filters.
- [ ] If the cause is a TS/Rust policy divergence, a test pins the two engines to the same age
      gate so the next divergence fails a build instead of accumulating 317 MB.

## Notes and lessons learned

[^1]: [id: quiet-pass-hides-stuck-target status: active keywords: "nothing in the log" "pass runs
    but does nothing" "files past retention still on disk" "live kept" idle vs stuck, ocd:
    2026-08-22 lmd: 2026-08-22] DO NOT gate a periodic task's ONLY log line on "it did something",
    BECAUSE a target that can never do anything then produces exactly the same output as a target
    with nothing to do — and the stuck one is invisible for as long as it stays stuck (measured:
    317 MB, 1045 files, 4+ days). DO make the two states distinguishable without making the idle
    case noisy: report the backlog a pass DECLINED to act on, not just the work it did.
