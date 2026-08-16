---
trdd-id: MFSUMOJ9
title: the standalone server grows its heap to the 6144MB ceiling and dies of GC thrash - OOM or watchdog SIGKILL
column: backburner
created: 2026-08-16T19:36:38+0200
updated: 2026-08-16T22:59:43+0200
current-owner: AgentlensPro session
task-type: spike
approval-tier: 0
---

# The heap grows to the 6144MB ceiling; GC thrash then kills the process

> **READ THE "MEMORY *IS* THE STORY" SECTION FIRST.** The sections above it are kept in the order
> they were discovered, because the sequence is itself the lesson — but two of them were RETRACTED
> and are struck through. The card opened as "CPU unexplained by throughput"; the CPU was the
> shadow, not the disease.

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

## ~~Ruled OUT: a memory leak~~ — RETRACTED, this was the central error

~~Heap across four 25s samples: **709 → 858 → 909 → 753 MB** — a clean GC sawtooth, reclaimed each
cycle, RSS oscillating 2286-2430MB against the 6240MB ceiling. Nothing monotonic.~~

**The measurement was accurate and the conclusion was false.** A 100-second window below the
ceiling cannot see a floor rising toward it. The process reaches 6135 MB and dies — see
"MEMORY *IS* THE STORY".

## NEXT ACTION (one step, runnable)

**Heap, not CPU.** Find what retains to 6 GB:

```bash
node --heapsnapshot-near-heap-limit=2 --max-old-space-size=6144 standalone/server.js
```

That writes a snapshot as the limit is approached — the growth phase this card kept failing to
sample — and the retainer tree names the holder directly. `--cpu-prof` is secondary now: the CPU
profile would just show GC, which the `mu = 0.042` figure already told us.

**You do NOT need to wait hours for it. It reproduces from a cold start.** A freshly restarted pid
was measured by another session at **249% of a core at 50 minutes uptime** (interval-differenced,
10s window), against ~130% on the previous pid at 3h+. So the cost is present from the beginning
rather than something that degrades with accumulated state — which means the whole investigation
fits on a short-lived instance, and a reproduction does not require a multi-hour soak. Lower the
cap (`--max-old-space-size=1024`) to reach the ceiling in minutes rather than hours.

The plausible retainers are the in-memory span window and whatever indexes it, but **do not guess
between them**: the snapshot answers it outright, and every guess made on this card so far has been
wrong in a way that took hours to unwind.

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

~~Memory independently re-measured by a second session (2336.6 → 2219.7 MB over 75s, net -117 MB)
matching this session's 709 → 858 → 909 → 753 MB heap sawtooth. The memory dimension is closed;
this card is CPU-only.~~ **RETRACTED — see "Memory IS the story" below. Three sessions
independently measured a healthy sawtooth and all three were sampling the same short window; the
process OOMs at 6135 MB.**

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

~~Memory remains healthy and is NOT the story: RSS 2179MB, heap 825/6240MB at 4h07m — lower than the
2.4GB peak measured an hour earlier.~~ **WRONG — retracted below.**

## MEMORY *IS* THE STORY — the heap OOMs at the ceiling (found 2026-08-16 ~22:45)

**This card previously declared memory excluded. That was wrong, and the way it was wrong is the
most instructive thing in it.** `~/.agentlens/server.log` carries two hard V8 crashes:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
             Allocation failed - JavaScript heap out of memory
  [73785] Mark-Compact (reduce) 6135.0 (6191.4) -> 6135.0 (6191.1) MB,
          average mu = 0.042, current mu = 0.000   ← reclaimed ZERO bytes
  [20885] Incremental Mark-Compact (reduce) 6089.8 -> 6041.1 MB, 729.44 ms
```

`--max-old-space-size=6144`, and the heap is at **6135 MB**. Mark-Compact freed **nothing**
(6135.0 → 6135.0). `average mu = 0.042` means the mutator received **4.2%** of the process's time —
GC took the other 95.8% — and `current mu = 0.000` means that at the end it was 100% GC.

### This unifies every symptom on the card into one failure

| observation | explanation |
|---|---|
| ~1.2-3 cores sustained | that is GC burning them, not work |
| ~1 event/sec throughput | the mutator only gets ~4% of the time |
| 63-second event-loop stall | GC thrash starves the loop; the watchdog then SIGKILLs |
| CPU *rising* over uptime | the heap is filling; GC cost climbs as it does |
| RSS "healthy sawtooth" at 2.2-2.6 GB | the pre-growth phase, sampled before the climb |

So the earlier framing had it backwards: high CPU is not the disease, it is the **shadow of an
unbounded heap**. The card keeps its id and its NEXT ACTION becomes a heap question, not a CPU one.

### Why three independent sessions all got memory wrong — the lesson worth more than the bug

This session, ai-maestro, and llm-externalizer each measured RSS/heap over 60-100 second windows,
all saw a clean GC sawtooth with a net decline, and all concluded "no leak". One session had even
raised a memory flag and **withdrew it** on that evidence. Every measurement was correct. Every
conclusion was wrong, because **a sawtooth measured below the ceiling says nothing about whether
the floor is rising toward it** — and three observers agreeing added no information, since all
three sampled the same phase of the same cycle.

The refuting evidence was in our own log the entire time and cost one `grep`. Corroboration between
observers is not independence when they share a method and a window; the log was the only
independent source, and nobody read it until a fourth session (the integrator) reported the pattern
we could not see from inside: **three pids in ~90 minutes**, each returning with RSS climbing again.

DO NOT re-close the memory dimension on another short-window sample. Close it only against the
ceiling: watch the heap FLOOR across a full growth cycle, or read the log.

**And the detail that should have ended this in the first ten minutes:** the janitor's alarm read
`a process RAM/CPU runaway`. It named BOTH dimensions from the very first fire. Four sessions then
spent an evening arguing about the CPU half — whether `ps %cpu` was a lifetime average, whether
sustained meant pathological, whether it was a burst — while the RAM half, stated in the same alert
string, was the disease. **When an alert names two dimensions, a debate that settles on one has not
narrowed the problem, it has dropped half of it.** The alarm was correct the whole time; only its
explanatory parenthetical was wrong, and that parenthetical is what captured the discussion.

A later measurement made the sampling error unarguable: a session that reported `2628 → 2541 MB,
falling` re-measured 15 minutes on and got **2732 MB** — above BOTH of its earlier samples. One
descent, sampled inside a climb, read as the trend.

## THE OTHER FAILURE MODE: event-loop starvation and watchdog respawn (found 2026-08-16 ~22:30)

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
