---
trdd-id: 5YL1OQV1
title: Redesign the spool so no body is ever lost and digestion runs continuously in the background
column: design
created: 2026-08-29T07:54:47+0200
updated: 2026-08-29T07:54:47+0200
current-owner: claude-agentlenspro
task-type: refactor
project-id: agentlenspro
parent-trdd: ZW4APOPI
blocked-by: []
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
0 failed, 0 stranded, spool back to 1%. A byte-identical backup was taken first to
`~/.agentlens/spool-backup-20260829_075138+0200` (4,271 files) so the reclaiming pass could not
lose anything. **That was a manual recovery of a symptom; this card is the cause.**

## The constraint that makes this hard — state it before proposing anything

**The producer is EXTERNAL and cannot be throttled.** Claude Code writes the bodies itself; nothing
in this repo is in that write path (verified: every `.request.json` reference under `src/` and
`rust-core/` is a reader). So there is no backpressure channel and no way to make the producer wait.

**Therefore "no data must ever be lost" is NOT achievable by draining faster.** A fixed-size buffer
plus an unthrottleable producer means some burst always wins the race; a faster drain only moves the
burst size that breaks it. The guarantee has to come from somewhere that does not depend on winning
a race — the leading candidate being **spill to SSD at a high-water mark**, converting the failure
mode from *silent loss* into *degraded write latency*. Awaiting the advisor verdict before
committing to that shape.

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

1. **Close the loss hole** (inherits ZW4APOPI's acceptance): `bodies_pass` iterates
   `resolve_bodies_read_scope`, with per-dir cap + `durable`; interval to 60 s in spool mode.
   Blocked only on the rc3 agent's `rust-core/` tree landing.
2. **Continuous digestion**: replace the fixed tick with a loop that keeps passing while
   `throttled:true` and backs off only when the spool is actually empty.
3. **The durability guarantee**: the spill-to-SSD (or equivalent) design, pending the advisor
   verdict recorded below.
4. **Make the failure visible**: `dropped_on_failure` and the spool's own free-space are currently
   unobservable — `/api/server-stats` reports `bodies.spool` as a hardcoded `Value::Null` stub
   (`server_stats.rs:365-367`). A guarantee nobody can check is not a guarantee.

## Advisor verdict

_Pending — fable-advisor consulted 2026-08-29T07:54. Record the ranked design here before writing
any code._

## Acceptance

- [ ] a burst larger than the spool's free space loses **zero** bodies (test: write past the
      high-water mark, assert every body is later present in the store)
- [ ] with the producer stopped, the spool drains to empty without operator action
- [ ] the spool's fill level and any drop counter are exposed in `/api/server-stats` and non-stubbed
- [ ] a reboot-while-full scenario has a stated, tested outcome rather than an assumed one

## Notes and lessons learned

The manual recovery worked and proves the ingest path is sound — 4,154 bodies, 0 failed, 0 stranded.
The defect was never in the digestion; it was that nothing pointed it at the spool, and that the
timer was an order of magnitude too slow for the buffer it guarded.
