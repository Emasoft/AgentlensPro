---
trdd-id: MFSUMOJ9
title: the standalone server burns ~1.5 cores sustained while ingesting about one event per second
column: backburner
created: 2026-08-16T19:36:38+0200
updated: 2026-08-16T19:36:38+0200
current-owner: AgentlensPro session
task-type: spike
approval-tier: 0
---

# Server CPU is not explained by its own throughput

## The measurement (four independent methods, two observers)

On pid 26449 (`node standalone/server.js`, ~1h55m uptime):

| method | value |
|---|---|
| lifetime `TIME/ELAPSED` | 6163.94s / 6914s = **89.2%** |
| `ps %cpu` (~1-min decaying avg), 4 samples | 121.5, 123.8, **168.5**, 123.9 |
| true delta, 250s CPU over a 157s wall window | **159%** |
| independent sample by another session | 89.2% lifetime, 123.9 reported |

All agree on **sustained 0.9-1.6 cores**, not a burst. The ~1-minute figure sitting ABOVE the
lifetime average means the process is currently busier than its own history — the opposite of
decaying off a spike.

## Why this is a finding and not just "a busy server"

**Sustained CPU is not by itself pathological.** A second flagged process on this host the same
evening (a video encoder under a live remote-desktop session) measured ~1.2 cores sustained and was
entirely legitimate. The finding here is the **gap between CPU and work done**, not the CPU number:

Across a 20s window `server status` advanced by **11 spans, 3 hook events, 21 log-events
persisted** — roughly **one event per second** — while burning over a core and a half.

## Ruled OUT: a memory leak

Heap across four 25s samples: **709 → 858 → 909 → 753 MB** — a clean GC sawtooth, reclaimed each
cycle, RSS oscillating 2286-2430MB against the 6240MB ceiling. Nothing monotonic.

## NEXT ACTION (one step, runnable)

Profile it. Do NOT hypothesize first:

```bash
node --cpu-prof --cpu-prof-dir=/tmp/alp-prof standalone/server.js   # or attach to the live pid
```

The plausible suspects are the in-memory span window (79k spans in the 1440m window) and the
on-disk store (5.6M spans / 31 segments), but **two status samples cannot separate them**, and
guessing between them is precisely the failure this card exists to avoid.

## Load-bearing gotchas for whoever picks this up

- **`ps %cpu` is NOT a lifetime average.** `man ps`: "a decaying average over up to a minute of
  previous (real) time." A claim to the contrary circulated across six sessions on 2026-08-16, was
  written into a shipped README (corrected in 92ff99e) and into another project's alert string and
  passing test. Verify before repeating.
- **The discriminator between sustained load and a burst** is comparing `TIME/ELAPSED` (lifetime)
  against the reported `%cpu` and against a real CPU-time delta. Agreement across all three means
  sustained.
- **`agentlenspro server status` can print `NOT RUNNING` for a live server** (see the sibling
  finding below) — its 800ms connect timeout loses to a busy server. Do not read that as the
  process having died mid-profile.

## Sibling findings from the same audit, also unfixed

Both in `reports/self-audit/` and both awaiting a USER scope decision:

1. **Unknown flags exit 0.** `list`, `server status`, `statusline-history project` accept
   `--definitely-not-a-real-flag`, ignore it, and exit 0. `last-compact` / `cache-expired` correctly
   exit 64 — the right parser already exists; the work is routing every entry point through it, and
   enumerating them all (only 5 were sampled).
2. **`server status` false-clean.** Reported `NOT RUNNING` while the server was alive and listening
   on 3000/4316/4318 (lsof-confirmed), contradicted by its own next line printing the live pidfile.

## Provenance

Surfaced by the janitor's `[system-daemon-runaway]` detector, which this session had previously
dismissed on a mechanism that turned out to be fabricated. The dismissal rested on uptime, PPID and
RSS and never on CPU; measuring the half that had never been evidenced is what produced this card.
