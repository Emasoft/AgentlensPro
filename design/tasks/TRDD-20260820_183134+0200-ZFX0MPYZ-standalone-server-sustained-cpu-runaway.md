---
trdd-id: ZFX0MPYZ
title: Standalone server sustains 150-270 percent CPU and 2.4 GB RSS over an 8-hour uptime
column: todo
created: 2026-08-20T18:31:34+0200
updated: 2026-08-23T04:43:41+0200
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

## 2026-08-23 04:20 — ~~BOX 1 UNTICKED~~ RETRACTED at 04:31; the off-main CPU is V8 GC, not fs

**The untick was an OVERCORRECTION and both of its premises were false.** Established twice
independently — by a 30 s `/usr/bin/sample` of all threads I ran myself, and by a third
adversarial review that reached the same two conclusions. Having overclaimed twice, I underclaimed
once; the record of all three is deliberate.

**FALSE — "the async `readdir`/`stat` load runs on those invisible threads".** All-thread sample
(`reports/cpu-runaway/20260823_042349+0200-allthreads-sample.txt`):

| thread class | in-window state |
|---|---|
| 4 × `libuv-worker` (the actual fs threadpool) | **23338/23338 samples in `uv_cond_wait` — 100% idle**, ~2.1 s lifetime total (0.04%) |
| 4 × `node-V8Worker` | ~98% idle in-window; their lifetime CPU is **V8 concurrent GC** (`ConcurrentMarking::RunMajor`) |
| main thread | the only meaningfully busy thread |

The fs threadpool does essentially nothing — that part is a direct read of the sample.

**The GC attribution is WEAKER than I first wrote it, and the overstatement is corrected here.**
I said this "measures box 2's GC-pressure candidate at ~21.6% of process CPU". It does not. The
21.6% comes from `ps -M` columns, which say those threads burned CPU but not what they burned it
on; the GC label comes from a thread NAME (`node-V8Worker`) plus one observed stack frame
(`ConcurrentMarking::RunMajor`). That is a strong indication, not a measurement — upgrading a
label into a number is the same move that produced three earlier defects. **To actually measure
it:** `--trace-gc` on a restarted server, or a `v8.getHeapStatistics()` delta series. Until then:
~21.6% of process CPU is off-main and *most likely* V8 concurrent GC.

**FALSE — "11.3% of a core, so the profiler is blind to the majority".** I computed that as
`busy_samples × 100 µs`, assuming the interval I requested. V8 never honoured it — effective
interval was **170.7 µs**. And the busy *fraction* is also wrong, because samples are NOT
uniformly spaced (a stalled sampler yields larger deltas on busy samples). The profile carries
`timeDeltas`; summed, they cover **100.0%** of wall clock, and the correct figure is:

| profile | main-thread busy | share of a core | my published figure |
|---|---|---|---|
| 45 s | 10.68 s | **23.5%** | (16.7% busy-fraction) |
| 60 s | 13.29 s | **22.0%** | **11.3% — wrong** |

**The "58–96% of process CPU" band I first published here was itself a window mix and is
withdrawn.** Its two numerators came from different windows over a bursty process — 22.0/23.5%
from the profiles' own intervals, 23.0–38.2% from three per-minute `TIME` deltas — so the band's
WIDTH was an artifact of the mismatch, not real uncertainty.

**Measured properly, both numerators from ONE identical window** (`ps -o time=` read immediately
before and after a 60 s profile):

**Four independent paired windows** (the first at 60 s, three more at 40 s — the harness makes
extra windows nearly free, so the n=1 version of this table was replaced rather than caveated):

| window | wall | process CPU | main-thread busy | main share |
|---|---|---|---|---|
| 1 | 60.3 s | 17.56 s | 12.01 s | 68.4% |
| 2 | 40.4 s | 12.09 s | 8.24 s | 68.2% |
| 3 | 40.4 s | 13.61 s | 9.63 s | 70.8% |
| 4 | 40.4 s | 8.69 s | 5.92 s | 68.1% |

**Mean 68.9%, range 68.1–70.8%.** The striking part is the stability: process CPU itself swings
**1.6×** across these windows (8.69 s → 13.61 s), yet the main-thread SHARE barely moves. The
absolute burn is bursty; the ratio is not — which is why a single window was enough to support
"the main thread is the majority", though not enough to name the number.

`ps -M` lifetime says 78.4% main, about 10 points higher than the windowed 68.9%. Not glossed:
the lifetime figure includes process startup, which is main-thread-heavy and would lift the
share. Both methods agree on the conclusion; they are not the same measurement.

**TRAP, hit while taking exactly this measurement:** `ps -o time=` prints **`MM:SS.ss`** here
(`90:45.41` = 90 minutes), not `HH:MM:SS`. Parsing it as `HH:MM:SS` yielded "1422 s of CPU in 60 s
of wall" — impossible, and only caught because it was impossible. A less absurd process would have
made the same bug invisible. Count the colons (`NF`), never assume the format.

**Box 1 is RE-TICKED with its scope stated:** the main thread is profiled and its frames named,
and the main thread is where the majority of the CPU is. The remaining ~21.6% is measured and
attributed to V8 concurrent GC, but not frame-attributed.

## 2026-08-23 04:30 — WHO calls it (measured) and a session-scaling HYPOTHESIS (not measured)

Inside AgentlensPro `check_cache_expiry` has exactly one caller — `src/cli/cacheExpiredCli.ts:115`
→ `callTool` → server HTTP. Nothing else in `src/`/`standalone/` calls it; the `agentlenspro gate`
and `agentlenspro hook` hooks do NOT.

The verb is driven from **outside this repo**, by **ai-maestro-janitor 3.3.26**:
`scripts/lib/agentlens_probe.py` (`DEFAULT_CACHE_EXPIRED_COMMAND = "agentlenspro cache-expired"`,
5 s subprocess timeout, fail-open), invoked by the heartbeat detectors
`scripts/detectors/window-burn-rate.py:50` and `scripts/detectors/token-usage-anomaly.py:37`,
plus `scripts/lib/external_clear.py`.

(The version is right for a better reason than the one I first had: the dispatcher stub
**re-resolves "latest cached version"** by its own documented design, so 3.3.26 — the highest of
the 11 cached — is what executes. My original basis was that it sorts last, which is the same
disk-artifact-for-the-thing shape as the retired-log-format defect above.)

**MEASURED:** 769 calls over 5h14m = **147 calls/hour**, each a full recursive `readdir` +
`statSync` over 14,509 files. That is an average over one window, not an observed rate law.

**HYPOTHESIS, NOT MEASURED — flagged because the first version of this section asserted it as
fact in its own heading.** The shape `cost = N_sessions × N_detectors × beat_rate` predicts the
burn scales with how many Claude sessions are open rather than with uptime. **I never measured
it.** One machine state, one session count, one rate — the causal arrow is asserted. Three
specific weaknesses, each fatal on its own:

- **`N_sessions` is itself a proxy.** The "30 `claude` processes" is `grep -c claude` over a `ps`
  snapshot, which counts helper processes, MCP children and this session's own subagents — not
  janitor-armed sessions.
- **It is self-undermining.** If load scaled with sessions, the pre-boot processes averaging
  5035 ms/call would imply MORE sessions then — yet I also explained that same gap by corpus size
  and by event-loop contention. Three explanations for one observation, none discriminated.
- **The 08-22 "healthy young server" is not evidence for it.** That process had 24 minutes of
  uptime, and this card already records that a young process proves nothing — then I reused it as
  confirming evidence for a different hypothesis.

**The discriminating experiment** (cheap, not yet run): sample the call counter and the
janitor-armed session count together at two points an hour apart. If calls/hour tracks the armed
count, the hypothesis holds; if not, this reframing is wrong and the fix target moves again.

**Neither timeout bounds the server:** the janitor abandons at 5 s, the CLI at 1500 ms
(`src/cli/main.ts:92`), and neither cancels server-side work — hence 25–65 s calls nobody awaited.

**NOT established:** the per-detector cadence/gating, so 147/hour is measured but its decomposition
across the 30 sessions is not. Full note:
`reports/cpu-runaway/20260823_043026+0200-who-calls-check-cache-expiry.md`.

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

- [x] The busy stack is IDENTIFIED, not guessed — a CPU profile (`node --cpu-prof`, or SIGUSR1 +
      inspector) taken against a server reproducing the condition, naming the hot frames.
      2026-08-23: ticked → unticked → RE-TICKED the same night; the untick was an overcorrection
      on two false premises (see the section above). Two inspector profiles (45 s / 257,123 and
      60 s / 353,511 samples) of pid 21567 name the MAIN-THREAD frames, and a paired measurement
      over ONE identical 60.3 s window (both numerators from the same interval) puts the main
      thread at 12.01 s busy against 17.56 s of process CPU = **68.4% of process CPU**. SCOPE,
      stated rather than glossed: the other ~31.6% is off-main and MOST LIKELY V8 concurrent GC
      (thread name + one stack frame — indicated, not measured); the libuv fs threadpool is
      100% idle, so it is not fs work.
- [x] The work is attributed to a trigger: a periodic timer, a request path, the log watcher, the
      span-store compaction, or GC pressure from the 2.47 GB heap.
      2026-08-23: on the MAIN THREAD, a REQUEST path (`check_cache_expiry`, 36.6% of busy)
      dominates; the `runLogScan` timer is 8.2%; GC 0.98%. Survives both correction rounds
      unchanged (the frames are non-recursive, so the double-count never touched them). CAVEAT:
      this attributes main-thread work only — see the box above.
- [ ] RSS growth is characterised as steady-state or as a leak — one measurement cannot tell them
      apart, so this needs a series, not a second snapshot.
      2026-08-23 04:41 — FIRST READ of the series (26 samples, 04:14→04:39, 1-min cadence, into
      `reports/cpu-runaway/rss-series-20260823_041323+0200.tsv`): **RSS OSCILLATES, it does not
      climb.** min 1.17 GB, max 1.53 GB, first 1.38 GB → last 1.36 GB; least-squares trend
      **−0.192 GB/hour** (negative); **19 of 24 steps reverse direction**. That is sawtooth —
      allocate/collect — and is the signature of steady state, not of a leak. Corroborated by the
      GC finding above: a ~1.4 GB heap under continuous concurrent marking is exactly what draws
      a sawtooth.
      **STILL OPEN, and this is the honest limit:** 25 minutes cannot exclude a leak whose
      timescale is hours, and the card's own observation was 2.47 GB at 8h12m against 1.36 GB
      here. The box closes when the 12 h series is read, not on this window.
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
