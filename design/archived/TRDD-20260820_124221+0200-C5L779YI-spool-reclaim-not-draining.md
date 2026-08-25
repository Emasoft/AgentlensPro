---
trdd-id: C5L779YI
trdd-id-full: C5L779YI
title: A volatile spool holds up to bodiesMaxGb of un-reclaimed bodies because the age gate cannot fire on it
column: complete
created: 2026-08-20T12:42:21+0200
updated: 2026-08-25T14:08:08+0200
implementation-commits: [c367961]
severity: MEDIUM
spawned: [8TM7I49X]
current-owner: AgentlensPro session
task-type: bugfix
priority: 3
effort: M
labels: [bodies, spool, data-loss, reclaim]
min-approval-requirement: none
relevant-files: [standalone/server.ts, src/rustStorePass.ts, rust-core/crates/agentlens-store/src/pass.rs, src/spoolBackpressure.ts]
release-via: none
---

# A volatile spool holds up to `bodiesMaxGb` of un-reclaimed bodies

*(Filed 2026-08-20 as "The bodies reclaim pass is not draining a VOLATILE spool". That premise
was refuted on 2026-08-22 — see below. The title changed with it; the original body is kept
verbatim underneath as the audit trail.)*

## REFUTED 2026-08-22 — the spool IS draining; this card fell into the trap it wrote down

**The premise is false.** `~/.agentlens/server.log` carries **278** reclaim lines, the most recent
from today:

```
[AgentLens] bodies → store: ingested 1619, reclaimed 1619 file(s) (0 already durable) (0.50GB read → 7.1MB new spans) [spool] [throttled — more next pass]
[AgentLens] bodies → store: ingested  944, reclaimed  944 file(s) (0 already durable) (0.50GB read → 5.5MB new spans) [spool] [throttled — more next pass]
[AgentLens] bodies → store: ingested  831, reclaimed  831 file(s) (0 already durable) (0.50GB read → 5.0MB new spans) [spool] [throttled — more next pass]
```

**Why `archived 0` was the normal state and not a fault.** The pass has TWO triggers and only one
of them can ever fire on a spool:

- the **age gate** (`bodiesMaxAgeHours` = 72 h) — measured today, the spool held 986 files
  spanning **0.42 h**, of which **0** were past 72 h. A RAM spool cannot accumulate 72 h of age;
  a reboot clears it first. So the age gate never admits a single spool file, by construction.
- the **over-cap valve** (`overCap ? maxAgeMs = 0`, i.e. ingest everything regardless of age).
  `bodiesMaxGb` is configured to **0.5 GB** here (not the 8 GB default) and the RAM disk is 2 GB,
  so `capBytes = min(0.5 GB, 70% × 2 GB) = 512 MB`. Measured today: **473.9 MB — just under it.**

So the spool drains in **0.5 GB bursts at the cap**, and sits at `archived 0` the whole time in
between. `last pass archived 0 (live kept 0.82GB)` was a snapshot taken between bursts. The
card's own closing note said it: *"a reclaim that archives 0 is indistinguishable from a reclaim
with nothing to do"* — and then read one as the other anyway. Writing the lesson down is not the
same as applying it.

**A tag that proves less than it looks like it proves.** Those lines all carry ` [spool]`, and it
is tempting to read that as "the spool target is what drained". It is not: the tag is
`${SPOOL_MODE ? ' [spool]' : ''}` (`standalone/server.ts:747`), a per-SERVER-MODE flag, and the
`console.log` sits OUTSIDE the `for (const target of drainTargets)` loop with counters summed
across both targets. One line per PASS. It proves **SPOOL_MODE is active** and nothing about
attribution. (Caught by adversarial review of this very refutation, which had used it as
attribution — the same class of error as the one being refuted, committed while refuting it.)

Of the four suspects listed below, **all four are still wrong**, on evidence that survives that
correction: SPOOL_MODE is active (the tag does prove that much), the flock is not held (a flock
skip logs its own line and none appears), the pass reads 0.50 GB per pass while the legacy dir
holds 317.6 MB in total — so it cannot be scanning only the legacy dir — and the throttle is
working exactly as designed (`[throttled — more next pass]` is the 0.5 GB/pass limiter doing its
job across a bulk drain).

## What SURVIVES the refutation — two real things, neither the one this card claimed

1. **The legacy target genuinely never reclaims.** `~/.agentlens/otel-bodies` holds 1045 files,
   all 96–147 h old, all past the 72 h gate, **static across two full 60 s pass intervals** while
   the pass demonstrably ran — and each pass reads 0.50 GB, more than the legacy dir's entire
   317.6 MB. **Split to TRDD-8TM7I49X** with the measurement; this card is not it, and merging
   them would rebuild the conflation.
2. **Up to 512 MB of captured bodies live ONLY in volatile RAM at any moment.** This card's real
   insight, and it survives intact: with the age gate structurally unable to fire on a spool, the
   cap valve is the *only* thing that ever moves a body to durable storage, so an unmount, a
   reboot, or a full volume loses everything written since the last burst. That is a **policy
   question, not a bug** — and it deserves a deliberate answer rather than being an emergent
   property of two knobs that were tuned for a different sink.

**This card is retargeted to (2).** The measurements below are kept verbatim as the audit trail
of how a burst-mode drain was read as a dead one.

## Why this is not cosmetic

Measured 2026-08-20 12:37 on the live server (pid 73022, uptime 2h22m):

```
bodies: archive 0 volume(s), 0 lumps, 0.00GB; last pass archived 0 (live kept 0.82GB)
```

The capture sink is **a mounted volume, not durable storage**:

```
OTEL_LOG_RAW_API_BODIES = file:/Volumes/AgentLensSpool/otel-bodies
/dev/disk28 on /Volumes/AgentLensSpool (hfs, local, nodev, nosuid, noowners, mounted by <user>)
```

`/Volumes/AgentLensSpool/otel-bodies` held **568 files / 0.37GB spanning only 3.2h**
(09:24 → 12:37 the same day). A spool that shallow means its whole contents are recent — and
an unmount, a reboot, or a full volume destroys **every body that has not yet been reclaimed
into the durable store**. Reclaim is the ONLY thing standing between capture and loss, and it
reports `archived 0`.

The durable store is real and healthy (`~/.agentlens/store` = 2.44GB, `manifest.json`,
`parts/`, `blobs/`, `bodies/`), so the machinery works — something is preventing THIS pass
from draining THIS spool.

## What is NOT the bug (checked, so the next session does not re-chase it)

- **The empty archive is correct.** `~/.agentlens/otel-bodies-archive` holds only
  `bodies-2026-07.wad.idx` — a sidecar with no volume. That is exactly the documented purge
  contract: the volume was verified lump-by-lump into the store, deleted, and its `.idx`
  retained as capture-time provenance (TRDD-K3WDPR7M). Do not "fix" this.
- **The server is not down or stale.** `agentlenspro setup --yes` → 8/8 PASS including the
  end-to-end self-test; 0 source files newer than the bundle; hooks exact-once; 20 telemetry
  keys exact.
- **The spool volume is mounted** and `com.agentlens.spool.plist` exists in
  `~/Library/LaunchAgents/`.

## Suspects, in the order worth checking

1. `SPOOL_MODE` not active in the running server, so the pass ticks on the legacy hourly
   cadence (3600s) instead of the 60s spool cadence — `BODIES_PASS_INTERVAL_MS` in
   standalone/server.ts. A 2h22m uptime would then have had ~2 passes, not ~140.
2. The pass is exiting on the flock (`exit 75` = benign skip-tick) every time — an orphaned
   `.pass.lock`. Note `~/.agentlens/store/.pass.lock` EXISTS in the directory listing.
3. The pass is scanning `~/.agentlens/otel-bodies` (the legacy dir) rather than the spool, so
   it finds nothing eligible while the spool fills.
4. A throttle (512MB) or skip-name state in `.pass-state.json` parking everything.

## Acceptance (ORIGINAL — answered by the refutation above)

- [x] Root cause NAMED with the measurement that proves it (not a plausible story). **There was
      no fault**: burst drain at the 512 MB cap, 278 logged reclaims, spool age span 0.42 h vs a
      72 h gate.
- [x] After the fix, `last pass archived N>0` with the spool's live bytes dropping. **Already
      true, without a fix** — see the three logged bursts above.
- [~] A regression check that fails when reclaim stops draining while the spool grows — silence
      must not read as "nothing to do". **Still wanted, moved to TRDD-8TM7I49X** (its acceptance
      box 3), where the target that IS stuck lives. A check written here would have had nothing
      to catch.
- [x] The 512MB throttle and the flock skip stay intact; the delete gate is NOT relaxed.
      **Nothing was changed** — the correct outcome for a refuted premise.

## Acceptance (RETARGETED — the surviving question)

- [x] A decision recorded on whether a volatile spool may hold up to `bodiesMaxGb` (512 MB here)
      of un-reclaimed bodies, WITH the loss window stated. **DECIDED 2026-08-25 (session, under
      the USER's standing decide-on-verified-facts delegation): YES, ACCEPTED.** Loss window: up
      to capBytes = min(bodiesMaxGb, 70% of the volume) — 512 MB on this machine — of raw bodies
      captured since the last cap burst, lost on unmount/reboot/full volume. Accepted because
      bodies are diagnostic raw captures (every ingested span is already in the durable store)
      and bursting at the cap is far cheaper than per-file draining. Revisit only if bodies ever
      become the sole copy of something irreplaceable.
- [x] Whatever is decided is stated where the code makes the trade — done in commit `c367961`, a
      comment block directly above `const overCap = liveBytes > target.capBytes` (the single spot
      both engine branches derive the `overCap ? 0 : BODIES_MAX_AGE_MS` ternary from), naming the
      dead age gate, the sole-trigger cap valve, the loss window and the acceptance.
- [x] `server status` stops inviting this misreading — commit `c367961`: the server tracks
      `bodiesReclaimedSinceBoot` + `bodiesLastNonZeroPassAt`, serves both on /api/server-stats,
      and the status line renders `reclaimed N file(s) since boot (last Nm ago); backlog X.XXGB
      not yet reclaimed`. "archived"/"kept" wording retired; an older server without the fields
      gets the legacy line (absent is not zero). Type-check + lint clean.

## Notes and lessons learned

The shape to remember: a reclaim that archives 0 is **indistinguishable from a reclaim with
nothing to do**. Only pairing it with "and the live dir holds 0.82GB" turns it into a defect.
Any status line reporting work done should report the backlog beside it.

That note was written on 2026-08-20 and was RIGHT — and on 2026-08-22 the pairing it prescribed
turned out to be insufficient, in a way worth keeping[^1].

[^1]: [id: bursty-pass-reads-as-dead-pass status: active keywords: "archived 0" "last pass did
    nothing" "live kept" reclaim not draining spool burst cap valve, ocd: 2026-08-22 lmd:
    2026-08-22] DO NOT conclude a periodic task is broken from ONE sample of a LAST-pass counter
    plus a non-empty backlog, BECAUSE a task that works in BURSTS reads as dead for the whole
    interval between bursts — here a 0.5 GB cap valve drained the spool 278 times while every
    single-moment reading said `archived 0`, and the backlog was non-empty by design because the
    age gate (72 h) can never fire on a sink whose contents span 0.42 h. DO check the LOG for
    historical work before believing an instantaneous counter, and DO ask what the trigger
    actually is before assuming the visible knob is it. Tell: a suspect list where every entry is
    a plausible mechanism and none has been measured.

[^2]: [id: mode-flag-is-not-attribution status: active keywords: "[spool] tag" "every line is
    tagged" which target drained log attribution per-pass vs per-target, ocd: 2026-08-22 lmd:
    2026-08-22] DO NOT read a status TAG on an aggregate log line as ATTRIBUTION for one of the
    inputs that line summarizes, BECAUSE `[spool]` here is `SPOOL_MODE ? ' [spool]' : ''` —
    a per-SERVER-MODE flag on a `console.log` that sits OUTSIDE the `for (const target of
    drainTargets)` loop with counters summed across every target
    (`standalone/server.ts:710,747`) — so "all 278 lines are tagged `[spool]`, therefore the
    legacy target never contributed" is an inference the log cannot support. DO check whether the
    emitting statement is inside or outside the loop whose items you are trying to distinguish,
    before treating its output as per-item. This error was committed *inside the refutation of a
    card that failed the same way*, and was caught only by adversarially reviewing it.
