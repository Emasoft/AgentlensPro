---
trdd-id: 34B9JAZK
title: get_cache_event_log still OOMs the server under real load after the partial fix
column: dev
created: 2026-08-08T15:24:01+0200
updated: 2026-08-13T22:25:00+0200
current-owner: agentlenspro-main
task-type: bugfix
severity: high
scope: project
project-id: agentlenspro
parent-trdd: QK3L5QAS
eht: [9NAUEUUR]
labels: [server, stability, cache-ledger, duckdb]
---

# get_cache_event_log still OOMs the server under real load after the partial fix

Residual of `TRDD-QK3L5QAS`, which was **closed prematurely**. That card's fix is real and still
verified — it is simply not sufficient.

## What is fixed, and what is not

**Fixed (still true):** `SegmentedSpanStore.loadRange` materialized every span in the window into one
array while the cache-ledger scan kept only `api_request`/`compaction` spans. `forEachInRange` now
visits instead. Out-of-process, `buildCacheEventLog({})` **completes in ~90 s** where it previously
aborted with `FATAL ERROR: Ineffective mark-compacts near heap limit` at ~4 GB. Re-confirmed
2026-08-08 against the current tree.

**Not fixed:** the same command still kills the **server**.

## Evidence

A CLI audit ran `agentlenspro get_cache_event_log` (no `--window`) against the FIXED bundle:

- exit 1, `FAIL: cannot reach http://localhost:4316/mcp: socket hang up`, wall **59.9 s**
- server pid **83918 → 37104**
- `~/.agentlens/requests.log`: heap **852 → 872 → 1768 MB** in the seconds before the call, then a
  **68-second gap** with nothing logged, then a fresh process at **478 MB** — an OOM-kill plus
  supervisor-restart signature

Verified first-hand rather than taken on the report: the live pid **is** 37104, started **15:14:10**
(mid-audit), and the bundle that process loaded contains `forEachInRange` (bundle mtime 00:12:20,
process start well after). So the fix was live and the server died anyway.

## The open question — do NOT guess it

**The mechanism is not established.** 1.7 GB before the call, against the server's
`--max-old-space-size=6144`, does not by itself explain reaching the cap. Candidates, none confirmed:

- a SECOND unbounded materialization on the same request path — `buildCacheEventLog` also calls
  `scanCacheCreationEvents` over the raw **body** files, which the QK3L5QAS fix did not touch;
- the server's resident state (≈70 k spans in memory, the segment index) plus concurrent ingestion
  leaving far less headroom than the 6 GB cap suggests;
- the MCP response serialization of a large result.

## 2026-08-12 — why it was never established, and the number that was missing

**The mechanism is still NOT established. What follows narrows it and removes a false lead; it does
not close the card.**

Measured first-hand on the healthy live server (pid 40460, 41 min uptime):

| | |
|---|---|
| heap | **860 MB** / 6240 MB cap |
| RSS | **2624 MB** |
| off-heap share | **~67 %** |

Two consequences, both verified rather than reasoned-from-memory:

1. **`--max-old-space-size=6144` bounds V8's old space, not RSS.** At steady state two thirds of this
   process's footprint is native — DuckDB's arena, buffers, the segment index — and none of it is
   visible to the heap number.
2. **`requests.log` recorded heap ONLY** (`src/serverRuntime.ts:116`, and a sample line confirms:
   `... 11b heap=920MB /api/statusline-samples`). So the incident evidence in this card — heap
   852 → 872 → **1768** MB — was never evidence about the thing that kills a process. 1768 against a
   6144 cap looks comfortable, which is precisely why three sightings produced no mechanism.

**A false lead this removes:** "the server hit its heap limit" is not supported. A V8 heap OOM is
self-announcing — the out-of-process run in the section above died with a visible
`FATAL ERROR: Ineffective mark-compacts near heap limit`. The server instead went **silent for 68
seconds and came back as a fresh pid**, which is the signature of an external `SIGKILL`, and an
external kill acts on **RSS**. That shifts weight onto candidate 2 (resident state + concurrent
ingestion leaving far less headroom than 6 GB suggests) and onto native allocation, and away from JS
heap exhaustion. It does **not** prove it: nothing here rules out candidate 1, and no kernel-level
kill record was recovered for pid 37104 (the sighting is four days old).

**Done about it:** `RequestLogEntry` now carries `rssMb` and every logged line reads
`heap=…MB rss=…MB` (one `process.memoryUsage()` call for both, so the pair can never be sampled at
different instants and report the impossible `rss < heap`). Falsified on behaviour: with the `rss=`
segment removed the new test fails on the actual line content.

## 2026-08-13 — SECOND live occurrence, and the owner's directive

It happened again, observed in real time: pid 40460 served its last request at **01:51:26Z**
(`heap=1002MB` of 6144 — looks perfectly healthy), then **silence, no V8 banner** (`server.log`
mtime untouched), and a fresh pid (51370) spawned at 01:52:27Z. The load at the time was a burst of
**diagnostic queries** — four `get_cache_break_timeline` raw-body scans, `get_session_detail`, four
`run_diagnostics_sql` snapshot loads — i.e. exactly the read-path family this card suspects, not
OTLP ingest. The `rss=` instrumentation from bd7b59f was **not deployed at the moment of death**
(the deploy had been withheld), so once again the kill happened with the one decisive number
unrecorded; it was deployed into the forced restart window at 01:54 (pid 60646) and every request
line now carries `rss=` — first live readings: `heap=1350MB rss=2547MB` during the boot scan.

**Owner directive (2026-08-13, verbatim intent):** "it should never happen that the server is
stopped unexpectedly" — the fix is ordered, not optional. Planned shape (session task #16): a
scratch-`DATA_DIR` repro driving the timeline/forensics query path while reading the `rss=` trend;
an RSS-pressure gate for heavy handlers (`heapPressure()` exists but keys on heap, which is blind
to the ~67% off-heap footprint); and a bound on the timeline's raw-body materialization.

**NEXT ACTION (unchanged in spirit — reproduce, do not guess):** re-run
`agentlenspro get_cache_event_log` with no `--window` against a **scratch `DATA_DIR` and `HOME`**,
never this machine's live server, and read the `rss=` trend in the new log. That trend is now capable
of showing the approach to the wall; the heap trend never was. If RSS climbs toward physical limits
while heap stays flat, candidate 1's `scanCacheCreationEvents` over raw body files is the first place
to look, because it is the one materialization the QK3L5QAS fix did not touch.

Guessing here is what closed the parent card early. Instrument the running server (heap sampling
across the call, or `--heapsnapshot-near-heap-limit`) and attribute the growth before changing code.

## 2026-08-13 afternoon — the kill reproduced live, three fixes landed, acceptance CLOSED

The full trail, in order (details in reports/lean-worker/20260813_120353+0200-rss-shed-34B9JAZK.md
and the commit messages):

1. **Scratch repro (worker, evidence-first):** 8.2GB synthetic corpus, full no-window scan —
   +215MB peak, pid stable. Both named suspects (`scanCacheCreationEvents`,
   `scanSessionsAndResponses`) ruled out AT TESTED VOLUMES; the multi-GB climb was not reproduced
   in scratch. The verified structural gap instead: the MCP endpoint — where every heavy
   diagnostic actually executes — had ZERO pressure protection (heavyGuard covers only 6 REST
   routes). Fixed: `rssPressure()` (fixed 4096MB default HWM, env-overridable) wired into both
   REST shed sites + a HEAVY_MCP_TOOLS shed at the MCP handler (f55ab34).
2. **The kill reproduced ON THE LIVE SERVER, instrument present this time:** pid 15661 died
   executing `get_cache_event_log` (the log's last line is the tool start; the client saw the
   socket hang up), rss ≈5.4GB, NO V8 banner, NO .ips crash report — an external/system-pressure
   kill, not a heap OOM. The 5.4GB residency was SELF-INFLICTED by the new boot compression
   sweep (31 segments' gunzip-verify buffers ratcheting the allocator) — fixed: the sweep now
   pauses under rssPressure() and resumes next pass (a98e7ae).
3. **The `rpc error (undefined)` wedge root-caused:** the MCP endpoint shared ONE SDK Server
   (Protocol) instance across connections; overlap threw "Already connected to a transport" and
   wedged every later rpc until restart (raw-probe verbatim, recorded). Fixed per the SDK's own
   prescription — a Server instance per connection (396d3bb). Falsification disclosed honestly:
   the interleave could not be forced in-process; the red is the live probe.
4. **Acceptance run (post-fixes):** 10 consecutive no-window `get_cache_event_log` completions
   against the live server's real store, pid 13448 unchanged, zero sheds fired, rss 4543→4777MB
   during (ps view) settling to 2158MB after.

**Accounting gotcha for HWM tuning:** `ps` rss read 4543-4777MB while the gate's
`process.memoryUsage().rss` stayed under the 4096 HWM (zero sheds) — the two accountings differ
(compressed/reclaimable pages). Tune `AGENTLENS_RSS_HWM_MB` against the gate's own number (the
`rss=` in requests.log uses the same source), never against `ps`.

**Still honestly open:** the named allocation site of the multi-GB climbs (scratch could not
reproduce them; the live 5.4GB instance was the sweep, now paused-under-pressure — whether a
DIFFERENT multi-GB path remains is unproven). The protections are in place either way; if a kill
recurs, the rss= trend plus the tool-start log line will name the call, and this card reopens.

## 2026-08-13 ~22:09 — THIRD live recurrence DURING the delegated review; card REOPENED to dev

The reopen clause fired. USER had delegated the human_review ("base your review of verified facts,
not assumptions"); while verifying, the live server changed pids. Facts, all read off disk:

- pid 65252 died at ~22:09:30+0200: its last logged request is 22:09:29.974 (`heap=1417 rss=2790`),
  and `[AgentLens] tool get_cache_event_log start` sits 9 lines from server.log's end — died
  EXECUTING the call, third instance, same external-kill signature (no V8 banner, no .ips report).
- **The RSS shed never fired and could not have**: the last gate-rss reading is 2790MB, under the
  4096 HWM. Whatever climbed, climbed inside ONE synchronous scan — and because that scan blocks
  the event loop, requests.log cannot sample during it. **2790 is a floor, not a peak: the
  instrumentation is structurally blind in exactly the fatal window.** This kills the "read the
  rss= trend" plan as stated; the trend stops at the tool-start line every time.
- Post-death, spawn refusals cite pids dead since midday (14576, 13448) — stale pidfile/lock
  content read by racing hooks — and pid 77910 (the current server) started 22:08:22 while 65252
  still answered at 22:09:29: a possible DOUBLE-OWNER window of ≥67s. Cross-ref TRDD-PIDFILEAT,
  which this escalates from a cosmetic defect to a store-integrity risk.

**NEXT ACTION (one step): make the blind window observable — in-scan RSS sampling.** Inside the
cache-event-log scan path (the forEachInRange visitor / evidence-load chunk loop), log
`process.memoryUsage().rss` every N units directly to server.log (bypassing the request path the
scan blocks). Only then rerun a controlled no-window call; the sample trail either names the
allocation site's neighborhood or exonerates the scan. Do NOT rerun the call before the sampling
exists — a fourth silent kill teaches nothing new.

## 2026-08-13 ~23:00 — the trail DELIVERED: mechanism named with measured evidence

In-scan sampling deployed (c622c76, pid 25527), then the controlled no-window rerun the card
prescribed. The call COMPLETED (74.7s, status 200) and the trail names the site:

```
rss-sample raw-body-scan   units=100..500      rss=2687MB (flat — raw-body scan is NOT the climb)
rss-sample otel-span-scan  units=500k  rss=2748MB heap=1287MB
rss-sample otel-span-scan  units=1.0M  rss=3646MB heap=2227MB
rss-sample otel-span-scan  units=2.5M  rss=4440MB heap=2997MB
rss-sample otel-span-scan  units=4.0M  rss=4714MB heap=3340MB   ← peak, ABOVE the 4096 HWM
rss-sample otel-span-scan  units=5.0M  rss=3367MB heap=2757MB
```

**Named mechanism:** `scanOtelCallEvents`' span walk over 5.4M spans generates ~2GB of TRANSIENT
heap per GC cycle (every visited span is a JSON.parse'd object graph; heap sawtooths 1.1→3.3GB and
rss follows GC timing, 2.6→4.7GB). The kills are a sawtooth PEAK coinciding with macOS memory
pressure — which is why they were sporadic, why the last logged rss was always a between-peaks
floor (2790), and why a shed keyed on rss AT CALL START can never catch it. Peak server heap
during the call: **3340MB measured** (closes the heap acceptance box). The raw-body scan is
exonerated: flat 2687MB across its window.

**Also observed, third face of the same family:** during the run (and a concurrent session's
`check_cache_expiry`), `server status` reported NOT RUNNING while pid 25527 was alive and working
— the synchronous scan blocks ALL listeners, so the 800ms status probe DROPs. This is the
mechanism behind every "NOT RUNNING on a healthy server" sighting, 861LC4VW's included.

**Fix direction (derived EHT card TRDD-9NAUEUUR):** the walk must (a) prefilter lines by span name
BEFORE JSON.parse (most spans are not api_request/compaction — the churn is mostly discarded
objects) and (b) yield periodically so listeners breathe. Protections stay as-is meanwhile; this
card cannot reach complete until 9NAUEUUR is terminal.

## Acceptance

- [x] The mechanism is identified with evidence — a named allocation site, not a hypothesis.
      (CLOSED 2026-08-13 ~23:00: the in-scan trail names scanOtelCallEvents' span walk —
      parse-then-discard transient churn, rss sawtooth 2.6→4.7GB over 5.4M spans; see the trail
      section. The boot-sweep residency was a second, already-fixed instance, a98e7ae.)
- [x] `agentlenspro get_cache_event_log` (no `--window`) completes against the live server, on this
      machine's real store, **10 consecutive times**, with the pid unchanged. One passing run is
      what produced the premature close; the count is the point.
      (CLOSED 2026-08-13 ~13:00 — pid 13448, 10/10, zero sheds, rss settling 2158MB after.)
- [x] Peak server heap during the call is measured and reported, not inferred.
      (CLOSED 2026-08-13: heap peak 3340MB / rss peak 4714MB, sampled from inside the scan.)
- [ ] A regression test that fails against the current code. If the honest shape is again a
      measurement rather than a unit test, say so explicitly rather than shipping a test that
      cannot fail.

## Workaround until fixed

Pass `--window`. Also note a separate UX defect found in the same audit: `--window` accepts a bare
number of minutes only — `--window 5m` is rejected with `FAIL: --window expects a number, got "5m"`.

## Lesson already recorded

One passing live run is not a general claim. The 00:12 run was true (exit 0, 36 s, pid unchanged,
184,212 calls) and insufficient — which is exactly what a premature close looks like from the
inside. Captured in the parent's `## Approval log`.
