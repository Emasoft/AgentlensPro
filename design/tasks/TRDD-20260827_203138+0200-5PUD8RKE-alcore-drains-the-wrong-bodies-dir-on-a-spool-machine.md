---
trdd-id: 5PUD8RKE
title: alcore's bodies chore drains only the legacy dir and would abandon the RAM spool
column: todo
created: 2026-08-27T20:31:38+0200
updated: 2026-08-27T20:31:38+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [rust, bodies, spool, cutover-blocker]
relevant-rules: []
created-by: TRDD-DMWOBWFH TS-core-to-Rust gap inventory (GAP-12)
blocked-by: []
---

## NOT a live incident — a CUTOVER BLOCKER. Read this before reacting.

The inventory that found this called it a "live data-loss defect". It is not live, and the
difference matters. Verified at `file:line`:

- `chores.rs` belongs to the **`agentlens-core`** crate, i.e. the **alcore** binary.
- alcore is **not installed** on this machine (`~/.agentlens/bin/` holds `alstore`, `alscan`,
  `allogscan` only) and **not published** (`npm view agentlenspro-darwin-arm64` → 404).
- The live drain runs **`alstore pass`**, and `src/rustStorePass.ts:61` passes the bodies dir
  **explicitly** (`['pass', storeDir, bodiesDir, …]`) — the target is chosen by the TS server,
  correctly, on every tick.

So nothing is losing bodies today. This becomes a data-loss defect **the moment alcore serves a
spool-configured machine**, which is precisely what TRDD-DMWOBWFH's cutover does.

## The defect

`rust-core/crates/agentlens-core/src/chores.rs:200` — `bodies_pass` hard-codes
`data_dir.join("otel-bodies")`, the LEGACY dir, and drains that alone.

## The false premise it rests on

`chores.rs:197-199` justifies the single target:

> *"the TS drains two dirs only in SPOOL_MODE, and the spool gate is `OTLP_PORT === 4318`, which
> alcore is not (it binds 4319)."*

**Measured false.** `SPOOL_MODE` is set at `standalone/server.ts:590-600` from
`CAPTURE_ON ∧ spoolDirConfigured(DATA_DIR) ∧ a mountable RAM disk`. `src/captureConfig.ts` contains
no port logic at all (`spoolDirConfigured:65`, `rawBodyCaptureEnabled:132`). The port never enters
it, so binding 4319 does not exempt alcore from spool mode — the comment's "the day alcore takes
4318 this becomes wrong" describes a condition that was never the real gate.

## Why it costs data rather than throughput

The spool is a **volatile RAM disk**. The TS server drains it every **60 s**
(`standalone/server.ts:968`) and applies backpressure at 70% of the disk
(`src/spoolBackpressure.ts`, ticking every 5 s at `:1057`). alcore would drain the near-empty
legacy dir hourly and never touch the spool: it fills unbounded, and volatile storage with no drain
and no backpressure loses its contents on reboot or overflow.

## Fix

Port the spool decision itself, not the path: `bodies_pass` must derive its targets the way the TS
does — capture enabled ∧ a configured spool dir ∧ a mounted RAM disk ⇒ drain BOTH dirs with the
per-target caps and the `durable` fsync-barrier flag (`standalone/server.ts:619-625`) — and the
false comment must go with it. This is GAP-12 of the port inventory and it is entangled with the
backpressure cluster (`ensureRamDisk`/`ramDiskInfo`/`spoolSizeMb`, `applySpoolBackpressure`/
`checkSpoolCapacity`/`runSpoolEvacuation`), which is ABSENT from Rust entirely.

## Acceptance

- [ ] `bodies_pass` drains both targets exactly when the TS would, decided by the same three
      conditions — not by a port, and not by a hard-coded path.
- [ ] A test with a configured spool proves BOTH dirs drain, and one without proves only the legacy
      dir does (the conditional half must survive, or the fix trades one wrong constant for another).
- [ ] Spool backpressure exists in Rust before any cutover on a spool machine, or the cutover
      refuses to run there and says why.
- [ ] The `chores.rs:197-199` comment is corrected — a false justification outlives the code it
      justifies.

## Related

- [[TRDD-DMWOBWFH]] — the cutover this blocks. Full inventory:
  `reports/rust-port/20260827_202829+0200-ts-core-to-rust-gap-list.md` (24 gaps, 14 absent).
