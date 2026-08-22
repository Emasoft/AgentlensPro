---
trdd-id: ZFX0MPYZ
title: Standalone server sustains 150-270 percent CPU and 2.4 GB RSS over an 8-hour uptime
column: todo
created: 2026-08-20T18:31:34+0200
updated: 2026-08-22T22:20:00+0200
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
`alcore serve` has been running **8h54m** against a `/var/folders/.../tmp.*` data dir at 0.0% CPU
/ 15 MB RSS — a test-spawned process that outlived its suite. Harmless for CPU, but it is a
leaked resource and belongs to whichever test spawned it.

## Acceptance criteria

- [ ] The busy stack is IDENTIFIED, not guessed — a CPU profile (`node --cpu-prof`, or SIGUSR1 +
      inspector) taken against a server reproducing the condition, naming the hot frames.
- [ ] The work is attributed to a trigger: a periodic timer, a request path, the log watcher, the
      span-store compaction, or GC pressure from the 2.47 GB heap.
- [ ] RSS growth is characterised as steady-state or as a leak — one measurement cannot tell them
      apart, so this needs a series, not a second snapshot.
- [ ] A fix lands with a REGRESSION GUARD that fails on the pathological input, not merely a
      measurement showing the number dropped on one run.
- [ ] The 96%-disk observation is either attributed to the server or explicitly excluded, with the
      measurement that decided it.

## Notes

- Reproduce against a server started on a SCRATCH `--data-dir`, never `~/.agentlens` — one data dir
  admits exactly one server, and pointing a second one at the live store is how the store gets
  corrupted.
- The measurement above was taken from a `ps` SNAPSHOT written to a file and then searched, never a
  live `pgrep`/`ps | grep` pipeline (which matches its own shell and reports a false positive).
