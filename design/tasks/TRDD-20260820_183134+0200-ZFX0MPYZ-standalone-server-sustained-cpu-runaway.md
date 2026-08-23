---
trdd-id: ZFX0MPYZ
title: Standalone server sustains 150-270 percent CPU and 2.4 GB RSS over an 8-hour uptime
column: todo
created: 2026-08-20T18:31:34+0200
updated: 2026-08-23T04:22:21+0200
current-owner: unassigned
task-type: bugfix
priority: high
severity: high
task-scope: standalone-server
---

# Standalone server sustains 150-270% CPU and 2.4 GB RSS over an 8-hour uptime

## Observation (2026-08-20, measured, not inferred)

The janitor's `system-daemon-runaway` detector fired on the live `standalone/server.js` process,
over the bar on two consecutive checks. A `ps` snapshot taken immediately after:

| field | value |
|---|---|
| elapsed | `08:12:40` |
| `%CPU` (1-min decaying avg) | **268.8** (detector reported 154 on its own sample) |
| RSS | **2,472,192 KB ≈ 2.47 GB** |
| UTIME / STIME | 60:00.45 / 5:34.51 |

**60 minutes of USER cpu-time over an 8-hour uptime, across at least two busy threads** (85.9% and
21.7% on the per-thread view). This is sustained work, not a burst: the process has spent ~12% of
its wall-clock life executing, on a machine that was mostly idle.

Host disk was simultaneously at **96% (83 GB free of 1.9 TB)**. The disk figure is NOT attributed to
the server here — this repo's own `rust-core/target` was 41 GB at the time — but it is recorded
because the detector reported the two together and a future reader should not re-derive the split.

## Why this is a NEW card and not an append

`TRDD-0XGU6NE2` (*"Audit response — maintainer claim that the server self-restarts and eats 2G/hr of
disk"*) is `column: complete` and therefore frozen. It answers a DIFFERENT claim: self-restart
behaviour and disk growth rate. Neither its question nor its evidence covers sustained CPU with a
flat 8-hour uptime — in fact the 8-hour uptime is direct evidence AGAINST the self-restart claim it
examined, which is worth noting when this is investigated.

## The leading hypothesis, and why it is only a hypothesis

`CLAUDE.md` records a prior incident of exactly this shape (2026-08-17, "server burns one core
continuously"), traced to a **full-store rescan when `windowHours` was absent** — minutes of one
pegged core per call on a 5.5M-span store. The fix was `scanOtelCallEventsIndexed` (TRDD-7I5805QM),
which serves sealed days from per-day sidecars and parses only the live segment.

That makes the indexed scan the first place to look, NOT the conclusion. Two threads busy at once
does not match a single unindexed scan, and nothing here has yet been traced to a call site. Do not
open with "it is the window scan again" — that is the shape of a confident wrong answer.

## 2026-08-22 — NOT reproducing, and the reason threatens the whole method

Sampled while working a neighbouring card:

```
pid 5644  elapsed 24:16  %CPU 8.7  RSS 1,380,000 KB   (standalone/server.js)
```

8.7% and 1.38 GB against this card's 268.8% and 2.47 GB. **That is not a refutation** — this
process is 24 minutes old and the original observation was at 8h12m uptime, so it has not had
time to reach the state being investigated. A young process reading healthy proves nothing about
an old one, which is exactly the trap the acceptance criteria already guard against by demanding
a series rather than a second snapshot.

**The problem is that an 8-hour uptime may no longer be obtainable.** The server was replaced
between 21:09 and 21:51 with no human or session action, and `~/.agentlens/.daemon-revive.lock`
is being rewritten every ~minute — so something restarts this process, and the 8h12m sample this
card rests on may have been the exception rather than the norm. Full measurement and the
candidate causes: the 2026-08-22 amendment on **TRDD-4FMHW124**.

**Consequence for the method, and it is load-bearing:** the first acceptance box asks for a
profile "against a server reproducing the condition". If the reviver clears the process before it
reaches the condition, that box is unsatisfiable in the field, and the reproduction has to be a
LONG-RUNNING SCRATCH server (see the note below about `--data-dir`) deliberately kept outside
whatever restarts the default one. Identify the reviver first — profiling a process that keeps
being replaced measures start-up, not the runaway.

Also seen in the same snapshot, unrelated to this card but recorded so it is not lost: an
`alcore serve` has been running **9h+** (8h54m, then 9h09m an hour later — still climbing)
against a `/var/folders/.../tmp.imEiZwa9vD` data dir at 0.0% CPU / 15 MB RSS. An orphan: its data
dir is temporary, so nothing consumes what it serves.

**Its origin is NOT established, and my first note here overclaimed it as "test-spawned".** The
correction matters because it changes who owns the fix: the only test that spawns alcore is
`src/test/alcoreCutover.test.ts` (single `child.kill('SIGTERM')`, :117), but that suite makes its
temp dirs with node's `mkdtemp` — which yields an `agentlens-*` prefix, **not** the `tmp.XXXXXXXX`
form of shell `mktemp -d`. So this was more likely started by a script than by mocha, and
attributing it to the test suite would send someone to harden a teardown that may already be
correct.

**Deliberately NOT killed.** It costs 0.0% CPU and 15 MB, its origin is unverified, and it is not
mine to reap on a guess — the cost of being wrong exceeds the 15 MB. Recorded instead.

## 2026-08-23 — PROFILED against a live reproduction; the trigger is a REQUEST, not a timer

Full evidence: `reports/cpu-runaway/20260823_040232+0200-live-profile-check-cache-expiry.md`.

The condition WAS obtainable after all: pid 21567 at **4h48m uptime, `ps %CPU` 93.6, RSS 1.39 GB**,
running the 23:00 bundle (pre-dating the 03:47 perf commit, so it is the code the original
observation was made on). SIGUSR1 + inspector, 45 s, 257,123 samples.

> **CORRECTED 2026-08-23 04:12 — two claims in the first version of this section were FALSE and
> are struck below. An adversarial review caught them and I verified both first-hand. A third
> defect it alleged is REFUTED, also first-hand. Read the corrections, not the originals:**
> `reports/cpu-runaway/20260823_040828+0200-adversarial-review-of-033ad2b.md`.

**~~The process was 83.3% IDLE during the window; `ps %CPU` is a LIFETIME AVERAGE, so this is
bursty, not sustained.~~ FALSE — INVERTED.** macOS `man ps` is explicit: "%cpu — The CPU
utilization of the process; this is a **decaying average over up to a minute** of previous (real)
time." This card's own line 24 already said "1-min decaying avg" and was RIGHT; I contradicted it
without addressing the contradiction, then built a headline on the contradiction.

**The correct sustained figure comes from `TIME/ELAPSED`, not `%CPU`:**

| process | elapsed | cpu time | sustained |
|---|---|---|---|
| profiled pid 21567 | 5:03:15 (18,195 s) | 83:07 (4,988 s) | **27.4% of one core** |
| original incident (2026-08-20) | 8:12:40 (29,560 s) | 65:35 (3,935 s) | **13.3%** |

So the profiled process burns **2.1× the original incident's sustained rate**. The burn IS
sustained; the card's original framing was right and my "bursty" correction was wrong. The 83.3%
idle reading is a true measurement of a 45 s window that happened to catch a quiet stretch — which
is precisely the one-snapshot error this card warns about for RSS, committed here for CPU. Minute
scale is genuinely spiky (93.6% at one sample, 12.9% two hours later); lifetime is not.

**~~`_collectJsonlFiles` 72.0% inclusive~~ FALSE — a 4.1× double-count. TRUE value: 17.4%.** My
inclusive rollup walked each sample's ancestor chain and added to a map keyed by frame LABEL,
deduping node ids but not labels — so a self-recursive function (`_collectJsonlFiles` recurses per
directory) was counted once per stack frame instead of once per sample. Verified by re-running
with per-sample label dedupe: `counted=72.0% TRUE=17.4%`. **My own `roots.mjs` had already printed
17.4% in the same session and I published both numbers without reconciling them** — the discrepancy
was in my own output, not hidden.

**The non-recursive figures are UNAFFECTED** (same re-run: `handleCheckCacheExpiry` 36.6%,
`getLastRequestMs` 36.1%, `statSync` 25.6% — identical before and after dedupe), so the trigger
attribution below stands. The top self-time chain
`statSync <- collectFileMeta <- transcriptPathFor <- getLastRequestMs` at 20.3% of busy is a
leaf-node measurement and was never subject to the double-count.

**Trigger, by root-to-leaf chain:** 36.6% of busy enters through `wrappedHandler →
handleCheckCacheExpiry` — an HTTP request, i.e. the `check_cache_expiry` MCP tool, reached from
`agentlenspro cache-expired` (`src/cli/cacheExpiredCli.ts:115` → `callTool`). The periodic
`runLogScan` timer is only 8.2%. **The dominant trigger is a request path.**

Cost from the server's own log: **1022 calls, 2210.7 s total**, mean 2169 ms, p50 771 ms,
p90 3930 ms, **p99 25.6 s, max 65.1 s** — against a CLI budget of 1500 ms, so the CLI abandons the
request while the server keeps working.

> **CORRECTED AGAIN 2026-08-23 04:20 — the paragraph that stood here "refuted" the review and was
> itself WRONG. Third correction on this section; the review was right both times.**

**~~This cost belongs to the profiled process; the review's contrary claim is REFUTED.~~ FALSE.**
I split the log on `Loaded N spans from …` and found the last at line 10,753 with zero calls
before it. **That marker is a RETIRED log format.** The current one reads
`Loaded N span(s) (last 24h window) from …`, so my grep matched only old-format boots and I
concluded "no boots after line 10,753" about a log with 199 successful boots (counted on the
`OTLP receiver →` line, which is emitted once per successful start; the 423 `Refusing to start`
lines are FAILED starts and must not be counted as boots).

**Correct split, on the real last boot (line 371,025 of 379,175):**

| window | calls | total | mean |
|---|---|---|---|
| **after last boot — the profiled process** | 769 | **728.7 s** | **947 ms** |
| before last boot — earlier, never-profiled processes | 313 | **1576.1 s** | 5035 ms |
| total | 1082 | 2304.9 s | |

So **68.4% of the cost belongs to processes I never profiled**, and I overstated the profiled
process's own consumption by **3.2×**. Worse for the earlier framing: the earlier processes averaged
**5035 ms/call against the profiled one's 947 ms**, so the p99/max outliers this card leaned on
most likely belong to those, not to the process the profile describes. Corroborating: the three
calls captured during a 60 s instrumented window measured 1193/693/1685 ms — the 947 ms regime,
not the 5035 ms one.

## 2026-08-23 04:20 — BOX 1 IS UNTICKED: the profile cannot see most of the CPU

A V8 CPU profile samples **only the main isolate thread**. `ps -M -p 21567` (per-thread):

| threads | cpu time | share of process |
|---|---|---|
| main | 67:37 (4,057 s) | **78.4%** |
| 4 × libuv threadpool | ~4:40 each (~1,120 s) | **21.6%** |

And in the instrumented 60 s window the gap is far wider than the lifetime ratio: the V8 profile
measured the main thread at **11.3% of one core**, while the process's own `TIME` delta over the
same minutes ran **23.0% → 38.2%**. So **the majority of the CPU in the window was burned off the
main thread, where the profiler is blind** — and node's async fs work (the very
`readdir`/`stat` load this section attributes) executes on exactly those threadpool threads.

This is a larger defect than either earlier correction. Box 1 asks that the busy stack be
"IDENTIFIED, not guessed". What the profile identifies is the *main thread's* stack, which is a
minority of the burn in-window. **Box 1 is therefore unticked** until the off-main-thread work is
measured (`--cpu-prof` does not cover it either; this needs `sample`/Instruments, `dtrace`, or
libuv-level instrumentation such as `UV_THREADPOOL_SIZE` variation with a controlled load).

**TWO HYPOTHESES WERE DISPROVED BY MEASUREMENT, and no fix was shipped on them.** (1) That
`collectFileMeta()`'s 2 s TTL is *born expired* because `_fileMetaCacheAt` is stamped with a
PRE-walk `Date.now()` — the code is exactly that (`src/logReader.ts:324`/`:387`) and the
arithmetic (`lifetime = TTL − walkDuration`) is real, but the measured walk is **820–879 ms over
14,509 files**, so it does not trigger at this corpus size. (2) That `transcriptPathFor` is an
O(all-files) scan run 12× per probe — structurally true, but **measured at 0 ms for 12 lookups
with 0 extra walks**, because entries are sorted newest-first and the probe ranks the newest
sessions, so lookups hit the front. Both are recorded in the report so they are not re-derived.

**What the 25–65 s tail actually is: wall-clock under contention, not that tool's CPU.** The
slowest calls OVERLAP each other and interleave with span ingest in the log; Node is
single-threaded, so a reported duration absorbs event-loop time spent on other work. That moves
the fix target from "one slow function" to the synchronous fs work blocking the loop plus the
absence of any concurrency control on overlapping probes.

**NOT established:** which call sites produce the p99 (contention is implicated, not proven
per-call); whether RSS is a leak or steady state (needs the series box 3 asks for); box 5. **And
the profile is ONE 45 s window** — it names the frames of the work it caught, which is what box 1
asks, but it is not proof that this mix holds across the other 5 hours. A second window at a
different hour would cost 45 s and is the cheap way to settle it; until then treat the mix as
sampled, not characterised.

**Trap recorded:** `out/logReader.js` is a STALE artifact of an older layout and lacks
`transcriptPathFor`; the live test build is `out/test/logReader.js`. A script requiring the
former silently measures old code — it cost two failed runs here.

## Acceptance criteria

- [ ] The busy stack is IDENTIFIED, not guessed — a CPU profile (`node --cpu-prof`, or SIGUSR1 +
      inspector) taken against a server reproducing the condition, naming the hot frames.
      2026-08-23: TICKED, THEN UNTICKED THE SAME NIGHT. Two inspector profiles (45 s / 257,123
      samples and 60 s / 353,511 samples) of pid 21567 name the MAIN-THREAD frames — but a V8
      profile is blind to the libuv threadpool, which holds 21.6% of the process's lifetime CPU
      and the clear majority of it in-window (main thread 11.3% of a core vs the process's
      23.0-38.2%). The async `readdir`/`stat` work this section attributes runs precisely there.
      Naming a minority of the burn is not identifying the busy stack. NEEDS: off-main-thread
      measurement (`sample`/Instruments/dtrace, or UV_THREADPOOL_SIZE variation under load).
- [x] The work is attributed to a trigger: a periodic timer, a request path, the log watcher, the
      span-store compaction, or GC pressure from the 2.47 GB heap.
      2026-08-23: on the MAIN THREAD, a REQUEST path (`check_cache_expiry`, 36.6% of busy)
      dominates; the `runLogScan` timer is 8.2%; GC 0.98%. Survives both correction rounds
      unchanged (the frames are non-recursive, so the double-count never touched them). CAVEAT:
      this attributes main-thread work only — see the box above.
- [ ] RSS growth is characterised as steady-state or as a leak — one measurement cannot tell them
      apart, so this needs a series, not a second snapshot.
      2026-08-23 04:13: a SERIES is now being collected — 1-minute samples of
      `pid/elapsed/%cpu/TIME/RSS` for 12 h into
      `reports/cpu-runaway/rss-series-20260823_041323+0200.tsv`. Early rows already show RSS
      oscillating (1.44 → 1.60 → 1.46 → 1.53 → 1.44 GB), i.e. sawtooth, not monotonic — but four
      points decide nothing and this box stays open until the series is read.
      TRAP, cost one failed start: a `setsid nohup … &` sampler launched from a tool call is
      REAPED with the process group. macOS has no `setsid`; use `scripts_dev/detach-run.py`
      (double-fork) and verify **ppid 1**. Already recorded in LOCAL memory as
      `detach-long-jobs-from-session-lifecycle`.
- [ ] A fix lands with a REGRESSION GUARD that fails on the pathological input, not merely a
      measurement showing the number dropped on one run.
- [x] The 96%-disk observation is either attributed to the server or explicitly excluded, with the
      measurement that decided it.
      2026-08-23: **EXCLUDED.** The server's ENTIRE data dir `~/.agentlens` is **6.2 GB** — 0.33%
      of a 1.9 TB volume; it cannot produce a 96% figure. This repo's `rust-core/target` is
      **69 GB**, 11× the server's whole footprint, and the card recorded it at 41 GB on 2026-08-20
      — so the build cache grew 28 GB in three days while the server held 6.2 GB. The volume has
      also recovered on its own to 90% / 202 GB free with no server change, which a server-caused
      figure would not do. Measurement:
      `reports/cpu-runaway/20260823_041540+0200-box5-disk-attribution.md`.
      (Noted, not acted on: `store.old-v0` (270 MB) looks like a stale migration artifact.)

## Notes

- Reproduce against a server started on a SCRATCH `--data-dir`, never `~/.agentlens` — one data dir
  admits exactly one server, and pointing a second one at the live store is how the store gets
  corrupted.
- The measurement above was taken from a `ps` SNAPSHOT written to a file and then searched, never a
  live `pgrep`/`ps | grep` pipeline (which matches its own shell and reports a false positive).
