---
trdd-id: MFSUMOJ9
title: the standalone server starves its event loop for 63s and is SIGKILL-respawned by its own watchdog
column: backburner
created: 2026-08-16T19:36:38+0200
updated: 2026-08-16T22:26:28+0200
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

## Corroboration (four sessions, all by interval differencing)

| observer | window | reading |
|---|---|---|
| this session | 20s × 3 | 116.8%, 188.4% |
| this session, earlier | 157s | 159% |
| llm-externalizer | 15s × 5 | 295.5 / 107.3 / 120.7 / 117.7 / 119.8 |
| ai-maestro | 2s | 191% |
| janitor | 10s | 286% |

**Sustained ~1.2 cores with excursions to 2-3.** And at 3h16m uptime the lifetime ratio has crossed
**100.5%** (11,866s CPU / 11,808s wall) — the server has averaged more than a full core for its
entire life, not merely for tonight's window.

Memory independently re-measured by a second session (2336.6 → 2219.7 MB over 75s, net **-117 MB**)
matching this session's 709 → 858 → 909 → 753 MB heap sawtooth. **The memory dimension is closed;
this card is CPU-only.**

## It is RISING, not steady (measured 2026-08-16 ~21:45)

The lifetime ratio is climbing, which means recent load sits above the running average and is
pulling it up:

| uptime | lifetime ratio | interval delta |
|---|---|---|
| 2h35m | 96.1% | 132% |
| 3h16m | 100.3% | 116.8%, 188.4% |
| 4h07m | **109.7%** | 158.8% |

So "sustained >1 core is the steady state" was itself too generous — over ~50 minutes the average
rose ~9 points. Reported `%cpu` in the same window swung 64.6 → 194.4 across 30s, which is a third
independent refutation of any cumulative/saturated model of that column.

Memory remains healthy and is NOT the story: RSS 2179MB, heap 825/6240MB at 4h07m — lower than the
2.4GB peak measured an hour earlier.

## THE SYMPTOM IS EVENT-LOOP STARVATION, not merely "high CPU" (found 2026-08-16 ~22:30)

The server restarted without anyone restarting it: **pid 26449 → 27917, PPID 1**. Not a mystery,
and not inferred — it is in our own log, verbatim:

```
[AgentLens] loop watchdog: event loop starved for 63s — self-healing (SIGKILL + detached respawn)
```

Two such fires in `~/.agentlens/server.log` (lines 104544, 289540). Both immediately follow ordinary
ingest lines ("Ingested 4 spans", "2 log events ingested") and are immediately followed by a boot
sequence reloading the 24h window — i.e. the process died and came back.

**This reframes the card, and sharpens it enormously.** ~1.2 cores sustained is a symptom; a
**63-second event-loop stall** is a diagnosis-grade fact. Node's loop does not starve for 63s under
merely "a lot of work" — that is a BLOCKING operation on the main thread, or a pathological GC/CPU
loop that never yields. It also explains the throughput paradox directly: ~1 event/sec while burning
a core is what a loop that cannot get back to its queue looks like from the outside.

The rising lifetime ratio (96.1% → 100.3% → 109.7%) now reads as the approach to that stall rather
than as an independent curiosity.

**The self-heal is working as designed** — production keeps its watchdog, and this is exactly the
case it exists for. That is not a reason to leave the stall in place: the watchdog is a seatbelt,
not a fix, and every fire costs a full reload of the 24h window (the boot line after fire #2 reloads
52,088 spans against a store of 4,383,202 across 30 segments).

**NEXT ACTION is unchanged but now much better targeted:** profile for a blocking main-thread call,
and grep the boot lines around each fire — `Loaded N span(s) (last 24h window)` — since the two
fires bracket window loads of 142,308 and 52,088 spans against stores of 1.6M and 4.4M.

### A LEAD, explicitly a hypothesis and NOT a finding

The in-memory span window grew 79,145 → 84,584 spans (+5,439) over the same ~50 minutes, against a
1440m (24h) retention horizon it has not yet reached. **If** per-turn work scales with window
occupancy, CPU would rise as the window fills and plateau when it saturates at 24h — which matches
the shape above. That is a testable prediction, not a diagnosis: it is recorded here so the profile
can confirm or kill it, and **it must not be treated as the cause until the profile says so.**
Tonight's fleet-wide lesson was precisely that a plausible mechanism which explains the numbers gets
believed without ever being tested.

## Load-bearing gotchas for whoever picks this up

- **`ps %cpu` is NOT a lifetime average, and NOT cumulative.** `man ps`: "a decaying average over up
  to a minute of previous (real) time." BOTH wrong models circulated on 2026-08-16 — "lifetime
  average" reached six sessions, a shipped README (corrected in 92ff99e), and another project's
  alert string plus a passing test; "cumulative and therefore saturated" reached three sessions
  later the same night. Measured refutation on this very process, reported `%cpu` beside lifetime
  from the same `ps` row, 20s apart:

  ```
  reported= 90.8   lifetime=100.32%
  reported=122.2   lifetime=100.34%   delta=116.8%
  reported= 95.5   lifetime=100.49%   delta=188.4%
  ```

  Lifetime moves 0.17 points while reported swings ±30 in the same 40 seconds. A cumulative figure
  cannot do that, and the two columns would be equal if it were one.

- **Interval differencing is THE measurement; nothing else is.** `ps -o time=,etime=` twice across a
  known gap, subtract, divide. An earlier version of this card said "lifetime, reported and delta
  AGREEING means sustained" — that is weak and is hereby corrected: past a few hours of uptime the
  denominator saturates, so the lifetime ratio *cannot* disagree with much and its agreement is
  nearly free. Treat it as corroboration, never as the measurement.

- **A LOW reading is real information.** Under either wrong model above, a 90.8% reading gets waved
  off as "pinned/stale." It is not — it means the process genuinely dropped to ~0.9 cores that
  minute. Both false mechanisms invert how a low number is read, which is why they were worth
  chasing down rather than shrugging at: the practical advice is the same either way, so a wrong
  mechanism passes review unnoticed and then changes somebody's conclusion later.
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
