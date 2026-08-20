---
trdd-id: C5L779YI
trdd-id-full: C5L779YI
title: The bodies reclaim pass is not draining a VOLATILE spool — measured 0.82GB live, 0 archived
column: todo
created: 2026-08-20T12:42:21+0200
updated: 2026-08-20T12:42:21+0200
current-owner: AgentlensPro session
task-type: bugfix
severity: HIGH
priority: 2
effort: M
labels: [bodies, spool, data-loss, reclaim]
approval-tier: 0
relevant-files: [standalone/server.ts, src/rustStorePass.ts, rust-core/crates/agentlens-store/src/pass.rs, src/spoolBackpressure.ts]
release-via: none
---

# The bodies reclaim pass is not draining a VOLATILE spool

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

## Acceptance

- [ ] Root cause NAMED with the measurement that proves it (not a plausible story).
- [ ] After the fix, `last pass archived N>0` with the spool's live bytes dropping.
- [ ] A regression check that fails when reclaim stops draining while the spool grows —
      silence must not read as "nothing to do".
- [ ] The 512MB throttle and the flock skip stay intact; the delete gate
      (ingest→FLUSH→fsync→verify→delete) is NOT relaxed to make this pass.

## Notes and lessons learned

The shape to remember: a reclaim that archives 0 is **indistinguishable from a reclaim with
nothing to do**. Only pairing it with "and the live dir holds 0.82GB" turns it into a defect.
Any status line reporting work done should report the backlog beside it.
