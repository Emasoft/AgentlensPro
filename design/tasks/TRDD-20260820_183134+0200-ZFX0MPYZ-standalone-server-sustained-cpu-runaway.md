---
trdd-id: ZFX0MPYZ
title: Standalone server sustains 150-270 percent CPU and 2.4 GB RSS over an 8-hour uptime
column: todo
created: 2026-08-20T18:31:34+0200
updated: 2026-08-23T05:35:09+0200
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

**Mean 68.9%, range 68.1–70.8%** — but stated precisely, because the general form is not what was
measured: **across a 1.6× swing in absolute process CPU (8.69 s → 13.61 s) within one ~5-minute
cluster, the main-thread SHARE moved less than 3 points.** That is meaningful precisely because
the swing was large. It is NOT the claim "the ratio is stable" in general — four windows minutes
apart on one process are a cluster, not a sample of the regime space, and the series records
extremes (93.6% vs 5.4% `%CPU`) that no window here spans.

`ps -M` lifetime says 78.4% main, about 10 points higher than the windowed 68.9%. **Both support
"the main thread is the majority"; the cause of the gap is UNMEASURED.** An earlier version of
this line explained it as main-thread-heavy startup — plausible, probably true, and never
measured. Offering an unmeasured mechanism is worse than stating the bare discrepancy, because it
closes a question the reader would otherwise check.

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
14,509 files**, so it does not trigger at this corpus size.
**→ AMENDED 05:10, RE-AMENDED 05:20.** Injecting a 2500 ms stall into the walk (TTL left at its
real 2000 ms) turns 5 probe candidates into **5 full walks** — past the cliff the memo does not
degrade, it DISAPPEARS. But **"CONFIRMED" overstated it and is withdrawn**: that proves the
MECHANISM (*if* `walkDuration > TTL` *then* collapse), not that the antecedent has ever held in
production. The only time it held is when I forced it. Correct phrasing: **reachable and
mechanically confirmed, not yet reached.**

**THE WALK TIME IS NOT A CONSTANT — that is the real finding, and my first two attempts to state
it were both wrong.** I quoted "820 ms" as *the* walk time throughout the night. Then, correcting
that, I promoted **1507 ms** to the operative headroom number — **the mirror image of the same
error**, a single draw from a dispersed quantity, this time the alarming end instead of the
convenient one. The defensible form is the distribution. n=16, all on the **same** 14,523-file
corpus:

**NO SUMMARY STATISTIC IS CLAIMED, and the third attempt at this paragraph is why.** The 16
observations come from three NON-EXCHANGEABLE designs and pooling them describes no real
population: 8 in-process repeats (warm process, warm allocator, JIT already compiled — samples 2-8
are conditioned on sample 1), 5 fresh-process runs (each paying startup + JIT warmup), and 3
ad-hoc samples taken hours apart. The in-process design contributed HALF the pool and structurally
cannot occur in production — the server does one walk per request from a long-lived process with a
cold memo, never eight in a row — so any pooled median is dominated by the cheapest condition.
**All that is defensible from these 16: the range is 143–1507 ms and the count is 16.**

A clean single-design measurement (20 fresh-process single-walk runs, 30 s apart) is running as of
05:19 → `reports/cpu-runaway/walk-clean-20260823_051928+0200.txt`. **Deliberately started BEFORE
writing the conclusion**, because the failure this card keeps repeating is not single-sample
reasoning — it is reaching for the number that supports the sentence already being written (820
supported "latent"; 1507 supported "urgent"; 317 supported "comfortable headroom"; each defensible
alone, each pre-selected).

> **PRE-REGISTERED 05:24, before the file was read:** the statistic is **p90 of the 20 runs against
> the 2000 ms TTL**, whatever it says; n/min/p50/p90/max all reported, verdict keyed to p90.

**RESULT (n=20, one design — fresh process, one cold-memo walk, 30 s apart):**
`126, 129, 133, 135, 146, 155, 317, 586, 624, 633, 658, 660, 666, 672, 679, 734, 737, 750, 769, 1902`

| | ms | % of the 2000 ms TTL |
|---|---|---|
| min / p50 | 126 / 633 | 6% / 32% |
| **p90 (pre-registered)** | **750** | **38%** |
| max | **1902** | **95%** |

**VERDICT, keyed to p90 as committed: p90 = 750 ms, below the 2000 ms cliff.** The pre-registration
is honoured — but it selected **the wrong FAMILY of statistic**, and that matters more than its
instability.

> **THE FAILURE IS A THRESHOLD EVENT, so the operative quantity is the EXCEEDANCE PROBABILITY, not
> a central quantile.** Any SINGLE walk over 2000 ms collapses the memo for that request's whole
> probe burst. p90 answers "where do most walks land" — a question nobody asked, because 90% of
> walks finishing comfortably is entirely compatible with the cliff being crossed several times an
> hour.
>
> **What the data actually bounds:** 0 of 20 runs exceeded 2000 ms. By the rule of three, the 95%
> upper bound on P(walk > TTL) is **3/20 = 15%**. At the measured 147 calls/hour that admits **up
> to ~22 memo collapses per hour**; even a 1% exceedance rate gives ~1.5/hour, each costing 5×
> walks by the stall measurement above.
>
> **Honest verdict from n=20: the exceedance rate lies somewhere in 0–15%, and this sample cannot
> distinguish those.** That is a materially different card from "38% of the cliff".

**Stated operationally, so neither number can be taken without the other:** *90% of walks finish
within 750 ms*, and *1 walk in 20 came within 98 ms of collapsing the memo*.

**The distribution is a MIXTURE, and I checked whether that invalidates the p90 — it does not.**
Clustering on the gaps (largest 769→1902 = 1133 ms; next 317→586 = 269 ms):

| regime | n | range | max as % of TTL |
|---|---|---|---|
| FAST | 6 | 126–155 ms | 8% |
| **MAIN** | **13** | **317–769 ms** | **38%** |
| OUTLIER | 1 | 1902 ms | **95%** |

**p90 = 750 ms lands INSIDE the MAIN cluster**, so it is not a cross-regime artifact. And the
regimes are **NOT a drift over the ten minutes** — I had reported the sample SORTED, which destroyed
the evidence needed to tell. In temporal order the sub-200 ms runs fall at positions
**3, 11, 12, 16, 19, 20 — interleaved, not contiguous**. So the bimodality is **per-call, not a
page-cache warm-up or a regime change**, which is what makes the exceedance framing above the whole
answer rather than a per-regime split.

The 769→1902 gap is still the largest in the data by 4×, so the outlier is a distinct event rather
than MAIN's tail. But **"1 run in 20 = 5% of runs" is a rate estimated from a SINGLE event** and its
interval is enormous — the rule-of-three bound (0–15%) is the defensible statement, not 5%.

Caveat kept: p90 of n=20 is the 18th order statistic and is not a stable estimator. The
pre-registration discipline worked; the CHOICE was poor, and naming p50 + max would have been
better.

**The cause of the spread is UNATTRIBUTED — and my refutation of my own explanation ALSO went too
far.** I wrote it was "OS page-cache warmth and machine load", which I never measured. I then
claimed the ordering (fresh-process runs 721, **1507**, 325, 172, 143) *refuted* page cache since a
cold-cache effect would put the max first. **That only kills a naive monotonic-decay model, which
is not how page cache behaves** — eviction is driven by memory pressure from other processes, and
on a machine running ~30 Claude sessions plus a 1.4 GB-RSS server, cold-warm-cold within five runs
is ordinary. So page cache is **not ruled out**; it is one of several candidates that **no design
here can separate**. Replacing an unearned mechanism with an unearned dismissal would leave the
next reader believing it had been excluded.
What survives: a 0.1% change in file count (14,509 → 14,523) cannot plausibly explain a 10×
spread, so the variance is not corpus-size driven. (Not run: `sudo purge`-separated cold/warm
walks — needs an interactive password in an unattended session.)

**Escalation path — two steps measured, two NOT.** A blanket "inference" label was not enough,
because this loop is the only thing making the defect urgent rather than merely latent, and its
measured endpoints made the whole chain read as measured:

| step | status |
|---|---|
| a slow enough walk collapses the memo | **MEASURED** (stall experiment) |
| collapse turns one walk per probe into N | **MEASURED** (5 candidates → 5 walks) |
| server load slows the walk | **NOT MEASURED** |
| the extra walks meaningfully raise load | **NOT MEASURED** |

Evidence: `reports/cpu-runaway/20260823_051050+0200-born-expired-mechanism.md`. The FIX is still
open (the advisor question on data-age vs cache-lifetime). (2) That `transcriptPathFor` is an
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
      2026-08-23 04:50 — FIRST READ (32 samples, 1-min cadence, into
      `reports/cpu-runaway/rss-series-20260823_041323+0200.tsv`). RSS oscillates between
      1.17 and 1.53 GB.
      **THE DISCRIMINATOR IS THE SAWTOOTH FLOOR, not the mean, the slope, or the direction
      changes.** Sawtooth RSS is what ANY garbage-collected runtime produces, leaking or not; a
      leak shows as a rising FLOOR, and the floor moves long before the mean does.
      **65-minute read (04:14→05:18, n=65), per-10-minute minima:**
      1.347 → 1.348 → 1.167 → 1.334 → 1.262 → **1.239 GB**. Floor trend **−0.108 GB/h**;
      first-to-last delta **−0.107 GB**.
      **WITHDRAWN — the "implied leak of (2.47−1.36)/8h = 0.139 GB/h" was FABRICATED.** It
      subtracts the RSS of ONE process from a DIFFERENT process and divides by the first one's
      uptime, silently assuming the 2026-08-20 process started at the value today's process happens
      to show. **Nobody measured that process's starting RSS.** At 2.0 GB the rate is 0.059; at
      0.8 GB, 0.209 — a 3.5× range, quoted as one figure to three decimals and then used as a
      verdict target.
      **AND THE FIRST FIX LEFT IT ALIVE.** My replacement paragraph still used 0.139 as the signal
      size in a power argument, one paragraph after deleting it — a section that says no legitimate
      target exists, then computes power against one.
      **BOX 3'S ANSWER, stated without any target rate — the MINIMUM DETECTABLE EFFECT.** From the
      floor's own scatter over 65 min: slope −0.108 GB/h, SE 0.104. With **n=6 the multiplier must
      be t at df=4** (2.776 + 0.941 = 3.72), not the normal 2.8 I first used: **95% CI
      [−0.397, +0.181] — spans zero**, and **MDE ≈ 0.39 GB/h**. Both corrections run in the
      conservative direction: the window is *less* sensitive than I claimed, and the "underpowered"
      conclusion is stronger, not weaker. σ̂ from 4 df is itself uncertain by ~2×, so quote this as
      **order 0.3–0.4 GB/h, one significant figure**.
      *This window can only resolve a leak faster than ~0.4 GB/h; anything slower is invisible.*
      SE(slope) ∝ σ√Δ/T^1.5, so scaling to the 12 h series is **720/65 = 11.1× the window → 37×
      finer → MDE ≈ 0.01 GB/h**. (I previously wrote ~8×/0.04 by applying a reviewer's *4× example*
      ratio to an 11× window — arithmetic on someone else's illustration instead of my own data,
      and it understated my own instrument by 4.6×.)
      On the block-minimum estimator I flagged: a CONSTANT block size makes its upward bias roughly
      constant across blocks, which shifts the intercept and not the slope — so trend estimation
      here is defensible after all.
      **The per-process rate, for construction not for value** (pid 21567, uptime 308→375 min,
      n=68): RSS 1.379 → 1.361 GB, endpoint **−0.016 GB/h**, least-squares **−0.046 GB/h** —
      **consistent with zero**, as the CI above shows. The contribution is that it uses ONE process
      across a known uptime interval; the number itself decides nothing.
      Two statistics I first published here are WITHDRAWN as non-discriminating: "19 of 24 steps
      reverse direction" (a real leak at this scale — ~2.5 MB/min against tens of MB of jitter —
      would flip direction just as often, so the count measures noise-to-step ratio, not
      monotonicity), and the mutual corroboration with the GC finding (circular: that attribution
      is itself only "indicated, not measured", and sawtooth does not discriminate leak from
      steady state either way).
      **The slope is REPORTED BUT NOT RELIED ON, and the reason is a modelling point worth
      keeping.** OLS gives −0.181 GB/h; residuals are NEGATIVELY autocorrelated (Durbin-Watson
      2.70, rho −0.36 — mean reversion, i.e. sawtooth), which makes the OLS standard error
      CONSERVATIVE (an alternating series carries more information than n independent points), so
      corrected |t| ≈ 4.1. **But that is a VARIANCE correction answering a BIAS objection.** The
      real worry is misspecification: a line fitted to an oscillation has a slope set by where the
      window cuts the cycle, and no standard-error adjustment touches that — shrink the SE to zero
      and a biased point estimate stays biased.
      Tested rather than argued, in two stages, and the second stage RETIRES the first.
      Sub-window slopes are 5/5 negative — but those windows overlap by 10 of 15 points, leaving
      only **2 independent** windows in 35 minutes. And the sign test has a precondition I never
      established: it discriminates drift from cycle-phase ONLY if a window spans a full
      oscillation. **Measured the autocorrelation to settle it: there is NO coherent period.**
      Max ACF is +0.37 at lag 2 min and +0.25 at lag 7, everything else below 0.15, decaying to
      ~0 by lag 11 and mildly negative after — no dominant cycle, so "phase" is not well-defined
      and the phase-artifact alternative is itself weakly supported. But that does not rescue the
      slope: **2/2 sign agreement is p = 0.25 under the null**, which is not evidence.
      **VERDICT: the drift is UNDETERMINED over this window.** Every support for it was removed in
      sequence — the t-statistic (computed inside a model the data contradicts), then the 5/5
      (non-independent), then the sign test (no discriminating power without a period) — while the
      confidence word "probably real" survived each removal unchanged. That is momentum, not
      evidence, and it was costing nothing to keep, which is exactly why it had to go.
      **Box 3 rests on the FLOOR, not on any of this.**
      **STILL OPEN:** ~35 minutes cannot exclude an hours-scale leak; the card's own observation
      was 2.47 GB at 8h12m against 1.36 GB here. An hour of data is enough to settle it, but state
      that in terms of the FLOOR, not the slope — an earlier version derived it from a
      linear-trend power calculation, which is computing power for a statistic this card has since
      retired as the wrong parameterisation of "leak". Read the FLOOR when the 12 h series lands.
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
