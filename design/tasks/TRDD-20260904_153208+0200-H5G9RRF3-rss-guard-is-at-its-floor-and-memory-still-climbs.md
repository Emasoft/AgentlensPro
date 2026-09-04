---
trdd-id: H5G9RRF3
title: The alcore RSS guard has bottomed out at its window floor with no second lever
column: todo
created: 2026-09-04T15:32:08+0200
updated: 2026-09-04T15:39:00+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
priority: medium
severity: MEDIUM
min-approval-requirement: none
created-by: main-session
npt: []
eht: []
blocked-by: []
related: [34B9JAZK, 2R0AXCKL, 2R36W8Q1, 768NEX6E]
---

# The alcore RSS guard has bottomed out at its window floor with no second lever

## Measured on the LIVE server, 2026-09-04 15:25–15:32 (pid 37180, uptime 6h22m)

| field | value | source |
|---|---|---|
| `spans.configuredWindowMs` | **86,400,000** (24 h) | `/api/server-stats` |
| `spans.windowMs` (effective) | **300,000** (5 min) | `/api/server-stats` |
| `SUMMARY_WINDOW_FLOOR_MS` | `5 * 60_000` = **300,000** | `span_window.rs:23` |
| `memory.rssMb` | **15,085** | `/api/server-stats` |
| RSS ~7 min earlier | **14,305** | `agentlenspro server status` (DIFFERENT instrument — see retraction) |
| `rss_budget_bytes()` default | **4,096 MB** | `lib.rs:634-641` |
| `spans.inMemory` | 418,018 | `/api/server-stats` |

**The effective window equals the floor exactly.** The guard has not merely fired — it has
exhausted its only lever. `apply_memory_pressure` (`span_window.rs:100-111`) halves
`effective_ms` while `rss > budget`, floored at `SUMMARY_WINDOW_FLOOR_MS`; going 86,400,000 →
300,000 is eight consecutive halvings into the floor. RSS sits at ~3.7× the value of
`rss_budget_bytes()` — but read the retraction below before using that ratio: the budget is the
TRIGGER for one degradation behaviour, not a memory ceiling.

So the degradation path is spent. There is no second lever.

## RETRACTION — "still climbing" was wrong, and the corrected series matters

The first version of this card said RSS "rose ~780 MB in seven minutes" and was "still climbing".
**Withdrawn.** That delta differenced TWO DIFFERENT INSTRUMENTS (`agentlenspro server status`'s
`rss=` line vs `/api/server-stats`'s `memory.rssMb`) which were never checked to agree, and a
trajectory was asserted from it.

Re-measured properly — same endpoint, same field, three points:

| t | `memory.rssMb` |
|---|---|
| ~15:26 | 15,085 |
| ~15:36 | **14,712** |
| ~15:37 (+57 s) | 15,015 |

**RSS went DOWN and then up.** It oscillates in a ~300–400 MB band around ~14.9 GB; it is not
monotonically growing. Any remediation reasoning built on "it is climbing and will eventually
die" is unfounded.

**The 57-second pair — NOT evidence of anything, and an earlier version of this card called it
"the sharper finding".** RSS moved +303 MB while `spans.inMemory` moved +25 (418,178 → 418,203)
with `windowMs` pinned at the floor. Two reasons that is not a finding:

- **The comparison is rigged by construction.** The window is CLAMPED at its floor, so span count
  is near-constant by definition. Any noisy numerator over a deliberately-constant denominator
  looks anomalous. I built a ratio from a variable I had just established was pinned.
- **Ordinary causes account for the magnitude.** `[[vmmap-ioaccelerator-is-the-mimalloc-heap]]`
  measured 74 × 128 MB mimalloc arenas on this binary — **two arena commits is 256 MB**, most of
  the 303. Add DuckDB query buffers (outside the Rust allocator entirely), background chores, and
  the 91.7 MB `/api/summary` response this session pulled minutes earlier, and none of it was
  controlled for.

**What would make it evidence:** sample `memory.rssMb` every 30 s for 15–30 minutes with no tool
traffic against the server. If the band oscillates and returns, it is allocator noise and this
paragraph should be deleted. If the FLOOR of the band rises monotonically, that is a leak signal.
A sampler was started 2026-09-04 ~15:44 (pid 46514, `nohup`) writing to `/tmp/rss-band.txt` —
30 samples × 30 s, so it completes ~16:00. **It was IN FLIGHT when the session that started it
ended.** Consequences for whoever reads this next:

- The file may be PARTIAL or ABSENT. `/tmp` is ephemeral and the pid died with its session's
  machine state; do not read a short file and conclude the band is narrow.
- Do not assume a run is still going. Re-run it rather than waiting on a pid from a dead session.
- The command, so it need not be reconstructed:
  `for i in $(seq 1 30); do curl -s http://127.0.0.1:3000/api/server-stats | python3 -c "import json,sys,time;d=json.load(sys.stdin);print(int(time.time()),d['memory']['rssMb'],d['spans']['inMemory'])"; sleep 30; done > /tmp/rss-band.txt`
- Read it with NO other tool traffic against the server — a single `/api/summary` fetch pulls
  91.7 MB through it and will show up in the band.

**Severity accordingly re-rated HIGH → MEDIUM.** The structural finding stands (the guard's only
lever is exhausted and nothing else responds to memory pressure), but the alarm figures around it
did not: "3.7× the budget" compares against a *trigger threshold for one degradation behaviour*,
not a memory ceiling; "47% past the wedging figure" computes a percentage against a single
anecdote in a doc comment; and the machine has 64 GB, so 15 GB is 23% of RAM with no OOM pressure
in evidence. Those were written one turn after a reviewer said I under-react to real findings —
over-correcting into inflated severity is the same error with the sign flipped.

## PRIOR ART I FAILED TO RECALL — `[[vmmap-ioaccelerator-is-the-mimalloc-heap]]`

The project wikimem already holds an alcore memory investigation (`ATOM-WA0C-AO6Q`, 2026-09-02,
`trdd: TRDD-768NEX6E` — itself a release blocker). It measured **8.8 GB resident / 6.5 GB dirty**
on alcore and established that macOS `vmmap`/`footprint` label the ENTIRE Rust heap
"IOAccelerator", because mimalloc tags its mmaps with VM tag 100. So:

- **Large RSS on this binary is a known, previously-characterised condition on this machine** —
  not a new incident, which is context this card lacked when it was filed at HIGH.
- The split to use is `IOAccelerator` = Rust-side heap, `MALLOC_*` = C/C++ side (DuckDB, which
  does not route through Rust's global allocator). Its 2026-09-02 reading was 74 × 128 MB arenas
  plus one 8 GB arena vs ~2.5 GB in the system MALLOC zones.
- **Do not chase Metal/GPU.** Those frameworks are transitive dyld loads; the binary links none.
- The recommended attribution method is already recorded: restart with `MIMALLOC_SHOW_STATS=1`, or
  expose a debug endpoint with per-structure byte estimates.

I wrote this card's "ESTABLISHED vs NOT" section listing "the DuckDB native arena" as an
unexcluded candidate while a note that splits exactly that was one `memgrep recall` away. The
recall-first rule exists for the case where you already have a hypothesis and therefore do not
feel you need it.

## The context that made this look HIGH — and why it does not carry that weight

`lib.rs:628-633`, the doc on the budget itself:

> *"Chosen against measurement, not taste: the TS server sat at ~1.5 GB on this machine's real
> corpus, and **an alcore flood reached 10.25 GB before wedging**. 4 GB leaves generous headroom
> over normal operation while cutting in well before the window can take the process down. A budget
> this guard never reaches would be decoration."*

The live process is at ~15 GB, above the 10.25 GB this comment mentions. **Do not compute a
percentage against that number, as an earlier version of this card did ("47% above").** It is one
recorded incident of *a flood* — a load pattern — in a prose comment, not a characterised
threshold, and nothing establishes this process is in a flood. TRDD-34B9JAZK is the
three-silent-kills card for this component, and `serverRuntime.ts`'s RSS instrumentation exists
because those kills were invisible — that history is why the observation is worth recording at
all, and it is also why it must not be dressed up beyond what was measured.

If the process dies, the in-memory span window is lost (418,018 spans, 2 pending at last read).
The machine is also at **96% disk** with 91 GB free and `never_free_space` in force, so recovery
options are narrow.

## What is ESTABLISHED vs what is NOT

**Established** (each read from source or measured on the live server):
- The guard's only response to `rss > budget` is halving the summarization window
  (`span_window.rs:100-111`). Nothing else is triggered.
- The window is at its floor, so that response is exhausted.
- RSS is ~3.7× `rss_budget_bytes()` and OSCILLATES in a ~300–400 MB band (15,085 → 14,712 →
  15,015 across three same-instrument reads). It is NOT established to be rising.
- Those ~300 MB swings do not track span ingestion: +303 MB against +25 spans over 57 s, with the
  window pinned at the floor throughout.
- The guard IS wired: `lib.rs:663` calls `apply_memory_pressure(rss_bytes(), rss_budget_bytes())`
  on the flush tick, and the narrowing is announced on stdout ("alcore: memory pressure —
  summarization window now …").

**NOT established — do not assume:**
- **WHY RSS is 15 GB.** A leak, the DuckDB native arena, the segment index, the log-events sink
  (2,067 MB on disk), or simply a large legitimate working set are all live candidates. None
  measured.
- **Whether the process is at imminent risk.** The machine has 64 GB total, so 15 GB is 23% of
  RAM — the 10.25 GB "wedging" figure is one recorded incident, not a threshold anyone has
  characterised.
- **Whether the floor is the right floor.** A 5-minute floor may be correct and the budget wrong,
  or vice versa.

## A hypothesis this measurement KILLED, recorded so nobody re-runs it

The obvious story was: high RSS → `underPressure()` true → `compressSealedSegments` pauses →
sealed segments never compress. **Falsified on disk:** `~/.agentlens/spans` holds **30 `.gz`
segments and 1 plain**, and the plain one is today's active segment, which
`compressSealedSegments` deliberately never touches (`if key >= todayKey { continue }`). The sweep
is working.

The reason it is working is the deeper correction: `rssPressure()` and `compressSealedSegments`
are **TypeScript** (`src/serverRuntime.ts`, `src/segmentedSpanStore.ts`), and the live server is
the **Rust** `alcore` binary. The 4096 MB constant in the TS code and the 4096 MB
`rss_budget_bytes()` in Rust are different guards that happen to share a number. Conflating them
is what made "the sweep must be stalled" look obvious; it is wrong.

This also means the seven `segmentedSpanStore` gzip test failures on TRDD-2R0AXCKL are NOT
explained by the live server's RSS — those tests run in their own mocha process. That remains
open there, and this card does not claim it.

## SCOPE NARROWED 2026-09-04 — the RSS-decomposition half is a DUPLICATE of TRDD-768NEX6E

`768NEX6E` is titled *"What does the 60 s bodies pass cost the machine, **and why is alcore 7 GB
resident**"*, and its one remaining open box is *"alcore's resident set is decomposed (span window,
log-session cards, summary cache, DuckDB pools) with a measurement, not an estimate; a decision on
the DuckDB `memory_limit` defaults follows from it."* That is verbatim what this card's original
acceptance box 1 asked for. It is a release blocker already (currently `blocked` by 7YPQWKPG).

**So the "why is RSS 15 GB" question is NOT this card's** — it is 768NEX6E's, has been since
2026-09-02, and duplicating it would split the investigation across two cards and two owners. That
box is removed here and the measurement handed over (below).

**What remains genuinely THIS card's, and is not in 768NEX6E:** the guard has exhausted its only
lever. `apply_memory_pressure`'s sole response to `rss > budget` is halving the summarization
window; the window is pinned at `SUMMARY_WINDOW_FLOOR_MS` exactly; and past that point the system
has **no defined behaviour for continued memory pressure**. That is a structural gap in the guard,
true regardless of what the 15 GB turns out to be made of.

## Acceptance
- [ ] A decision is recorded on whether the guard needs a second lever once the window floor is
      reached, or whether the floor/budget pair is simply mis-set for this corpus.
- [ ] `/api/server-stats` exposes whether the window is at its floor as an explicit signal — today
      a reader must know `SUMMARY_WINDOW_FLOOR_MS` and compare by hand to tell "degraded to the
      floor" from "configured that way".

## Notes and lessons learned

- **The reported "5m window" is a DEGRADED value, and nothing says so.** `agentlenspro server
  status` prints `spans: … (5m window)` with no indication that the configured value is 24 h and
  the process has been cut 288-fold. I read that line earlier in this session and took it for
  normal operation. That is what acceptance box 3 is for.
- This card exists because a reviewer pointed out that I had observed `rss=14305MB`, declined to
  file it, and declined to investigate it — citing an earlier criticism about "enumerating instead
  of fixing" as the reason. That criticism was about filing *testable* hypotheses instead of
  testing them; inverting it into a reason to do neither is worse than the original error, because
  it arrives dressed as a lesson learned.
