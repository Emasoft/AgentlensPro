---
trdd-id: 0SA5QZTG
title: Real-corpus tests read the LEGACY bodies dir while capture writes to the RAM spool
column: todo
created: 2026-08-22T20:46:35+0200
updated: 2026-08-22T20:46:35+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [bodies, capture, observability, silent-failure]
approval-tier: 0
relevant-files: [src/captureConfig.ts, standalone/server.ts, src/cacheCreationForensics.ts]
---

# Raw body capture has been dead for days and nothing noticed

## CORRECTED 2026-08-22T21:05 — the original premise was FALSE

This card was filed as "raw body capture has been dead for days". **Capture is alive.** It writes
to a RAM-disk spool at `/Volumes/AgentLensSpool`, not to `~/.agentlens/otel-bodies`, and it is
producing right now (`capture: 388 live file(s), newest 0s ago`; 316 -> 388 in two minutes).

**How the wrong conclusion was reached — three compounding measurement errors, all mine:**

1. **A failed command read as a measurement.** `find <dir> -newermt "-45 minutes" 2>/dev/null | wc -l`
   returned `0` and was taken as "nothing captured". This machine's `find` is **bfs**, which
   REJECTS relative timestamps; the command errored, `2>/dev/null` swallowed it, and `wc -l`
   counted zero lines of nothing. *The signature failure of this whole session: a proxy read in
   place of the thing.* Node was eventually used because `date -v` (BSD) and `stat -f` (BSD) also
   fail here while `find` is bfs — the shell mixes dialects, so portable measurement means Node.
2. **The wrong directory.** Everything was measured in `~/.agentlens/otel-bodies` — the LEGACY
   dir. Under `SPOOL_MODE` (`standalone/server.ts:548-563`) `PRIMARY_BODIES_DIR` becomes the
   configured RAM spool. The legacy dir being frozen at 2026-08-18 is **correct behaviour**, not a
   fault: nothing has written there since spool mode came on.
3. **`AGENTLENS_CAPTURE_RAW_BODIES` absent was read as "capture off".** It is not the switch that
   was being observed; capture runs without it in this configuration.

**What actually revealed the error:** the `capture:` status line added by this very card. It
reported 316 files with a newest of 3 seconds while the card claimed a 4-day outage — a direct
contradiction that could not be talked around. The feature caught its own author.

## THE REAL DEFECT (what this card is now about)

**The real-corpus tests read `~/.agentlens/otel-bodies` while capture writes to the spool.**
`src/test/bodyStore.test.ts:12` hardcodes `REAL_BODIES = ~/.agentlens/otel-bodies`, and
`cacheBreakTimeline`'s tests resolve `defaultBodiesDir()`. So the "live corpus" those tests
exercise is a **frozen, partially-drained leftover from before spool mode** — which finally
explains TRDD-R2VF2I53's adjacency gaps without inventing a drain story: the surviving legacy
files are the residue the pass had not yet ingested when the spool took over, so they are
*inherently* non-consecutive.

That also means the "green twice while the server drains live" criterion was never testable the
way it was written — the tests were not looking at the dir the drain is draining.

## Acceptance

- [x] `server status` reports capture state and the newest body's age (shipped with this card —
      and it is what exposed the false premise above).
- [ ] Real-corpus tests resolve the SAME dir the server captures to (spool when in spool mode,
      legacy otherwise) instead of hardcoding the legacy path — or state explicitly that they
      test the legacy residue on purpose.
- [ ] TRDD-R2VF2I53's adjacency finding re-checked against the SPOOL corpus, where turns should
      actually be consecutive. The 0.70 threshold was derived entirely from legacy residue and
      may be measuring an artifact.
- [ ] The archive question separated and answered: newest archive index is 2026-07-14 while
      `bodiesMaxAgeHours` defaults to 72 h — either the legacy residue should have been archived
      long ago, or the age knob is not the trigger.

## What was measured (2026-08-22, first-hand)

| fact | value |
|---|---|
| newest file in `~/.agentlens/otel-bodies` | **2026-08-18 20:39** (~4 days old) |
| bodies written since the server booted (~45 min) | **0** |
| live spool | 540 files / 320 MB |
| `AGENTLENS_CAPTURE_RAW_BODIES` on the running server | **not set** |
| newest archive index in `otel-bodies-archive` | **2026-07-14** |
| server | RUNNING, pid 69193, canonical, 4.7 M spans in store |

Capture is gated on `AGENTLENS_CAPTURE_RAW_BODIES` (`src/captureConfig.ts:21`) and that variable
is absent from the running server's environment. So the raw-body corpus has been a **frozen
snapshot** for four days while the server reported healthy throughout.

## Why this is worse than a stale directory

Everything that reads raw bodies has been answering from a four-day-old corpus, silently:

- `investigate_burn` and `get_cache_event_log` — the two tools the doctrine names as
  authoritative for "what burned the window" and "did that turn miss the cache".
- `ctxmap` / `ctxvis`, whose whole premise is that the captured raw body is the ground truth
  the session JSONL cannot provide.
- Every real-corpus test, including the one that surfaced this (TRDD-R2VF2I53).

**A monitoring product stopped monitoring and did not notice.** That is the defect; the stale
files are only its symptom. Nothing in the server's own health surface — `server status` prints
spans, store size, log sessions — mentions body capture at all, so there was no place for it to
show up.

## What is NOT established

- **Whether capture stopping was deliberate.** The env var may have been dropped from a launch
  path, or intentionally disabled to save disk. Determine which BEFORE re-enabling: this writes
  raw request bodies (which carry prompts and file contents) to disk, so turning it back on is
  not a neutral act.
- **Whether the archive/drain pass is also broken.** Suggestive but unproven: `bodiesMaxAgeHours`
  defaults to **72 h**, all 540 live files are ~96 h old, and the newest archive index is from
  **July 14** — so files past the age threshold are sitting un-archived. That may be a second,
  independent defect, or it may be correct behaviour (e.g. the pass is size-driven in practice and
  320 MB is under the 0.5 GB cap). **Do not conflate the two failures** — see the lesson below.

## Acceptance

- [ ] `server status` (or `/api/server-stats`) reports body-capture state and the age of the
      newest captured body, so this class of silence is visible without a filesystem check.
- [ ] A decision recorded on whether capture should be on by default on this host, WITH the
      privacy consideration stated, not just a flag flipped.
- [ ] The archive-pass question resolved either way: either files past `bodiesMaxAgeHours` are
      archived, or the age knob is documented as advisory and the real trigger named.
- [ ] Any tool that answers from raw bodies degrades HONESTLY when the corpus is stale — the
      existing `coverage.note` pattern is the precedent to follow, not a new mechanism.

## Notes and lessons learned

Surfaced while closing TRDD-R2VF2I53, whose test depends on this corpus. The reasoning around it
went wrong twice in opposite directions and both are worth keeping[^1].

[^1]: [id: frozen-spool-two-failures status: active keywords: "spool is frozen" "nothing is
    draining" "newest file is days old" "unchanged file count" capture vs drain, ocd: 2026-08-22
    lmd: 2026-08-22] DO NOT read "the directory has not changed and its newest file is days old"
    as "the drain is not running", BECAUSE an idle drain and a dead CAPTURE produce byte-identical
    evidence — a drain with nothing to drain looks exactly like a drain that is broken, and the
    discriminator is whether anything is being PRODUCED (`find -newermt` against the server's boot
    time), not whether the directory changed. DO establish production first, then consumption.
    The error compounded: a first claim ("the drain caused the gaps") was unverified, and its
    retraction ("the drain CANNOT have caused them") was asserted more confidently on evidence
    that pointed at a different subsystem entirely — leaving a worse position than the original
    guess, committed into a code comment as fact.
