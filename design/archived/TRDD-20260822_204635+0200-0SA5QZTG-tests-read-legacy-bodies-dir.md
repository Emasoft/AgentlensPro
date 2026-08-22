---
trdd-id: 0SA5QZTG
title: Real-corpus tests read the LEGACY bodies dir while capture writes to the RAM spool
column: complete
created: 2026-08-22T20:46:35+0200
updated: 2026-08-22T21:14:00+0200
spawned: [8TM7I49X]
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
- [x] Real-corpus tests resolve the SAME dir the server captures to (spool when in spool mode,
      legacy otherwise) instead of hardcoding the legacy path — or state explicitly that they
      test the legacy residue on purpose. **Done:** `src/test/bodyStore.test.ts` now resolves
      through `resolveBodiesReadScope(dataDir, env)` — the server's OWN reader scope
      (`src/captureConfig.ts:104`), already the resolver `cacheCreationForensics.ts:49` uses, so
      there is one answer to "where are the bodies" and not a second hardcoded one. Verified live:
      `dirs = [/Volumes/AgentLensSpool/otel-bodies, ~/.agentlens/otel-bodies]`, `missing = []`.
- [x] TRDD-R2VF2I53's adjacency finding re-checked against the SPOOL corpus, where turns should
      actually be consecutive. The 0.70 threshold was derived entirely from legacy residue and
      may be measuring an artifact. **Answer: the threshold is fine; the DIRECTORY was the
      artifact.** Same algorithm, same hour, the two dirs answer differently:

      | dir | bodies | largest session | longest run sharing >=70% | test |
      |---|---|---|---|---|
      | `~/.agentlens/otel-bodies` (legacy residue) | 400 | 54 turns | **3** | SKIPS (floor is 5) |
      | `/Volumes/AgentLensSpool/otel-bodies` (live) | 383 | 65 turns | **33** | RUNS |

      Mean shared prefix is 34% on the residue and 81% on the live spool. So there was never a
      missing-adjacency phenomenon to explain — and "the drain removed the adjacency", the text
      that stood in the test, would have been the THIRD wrong cause in a row for the same
      artifact. The adjacency test now RUNS (914 ms, asserting the >2x floor) instead of skipping;
      full suite **2440 passing / 0 failing / 8 pending**.
- [x] The archive question separated and answered: newest archive index is 2026-07-14 while
      `bodiesMaxAgeHours` defaults to 72 h — either the legacy residue should have been archived
      long ago, or the age knob is not the trigger. **Answer: neither. The `.wad` archiver was
      RETIRED** — `standalone/server.ts:591-597` records that the bodies pass "REPLACES the old
      .wad archiver", which had no cross-body dedup and an unbounded boot pass (694 MB/min of
      device writes). Bodies now go into the content-addressed store instead, 167x smaller. So a
      newest archive index of 2026-07-14 is the DATE THE ARCHIVER WAS RETIRED, not a stalled pass;
      the archive dir is read-only history (`extractArchive`, server.ts:3685) plus a retention
      purge (`purgeArchiveVolumes`, server.ts:726). And `bodiesMaxAgeHours` is **not** advisory or
      dead: it is the ingest pass's age gate (`server.ts:685,693` → `ingestPass.ts:224`,
      `f.mtime < cutoff`), zeroed to "ingest everything" when a dir is over its size cap.

      **But answering it surfaced a DIFFERENT, real defect, filed separately** rather than folded
      in here: the legacy dir still holds **1045 files / 317.6 MB, every one of them 96–147 h
      old** — all past the 72 h gate, in a dir that IS a drain target every 60 s
      (`drainTargets`, server.ts:580-586). Past the age gate and not draining is not the archive
      question; conflating them is exactly what this card's own lesson warns against.
      Filed as **TRDD-8TM7I49X** with the measurement, the four candidate causes (none verified —
      this card went wrong three times by picking one), and the next runnable check.

## Approval log

- 2026-08-22T21:14:00+0200 — COMPLETED by main (self-orchestrating, tier 0). All four live
  acceptance boxes ticked with first-hand measurements; the one thing this card surfaced that it
  could not close was split to TRDD-8TM7I49X rather than left in prose.
- 2026-08-22T21:52:00+0200 — POST-CLOSE CORRECTION (append-only; the card body stays frozen).
  Adversarial review falsified two claims made above, both fixed in **dd19f98**:
  (a) box 3's "the adjacency test now RUNS ... 2440 passing" is a SNAPSHOT, not a settled outcome
  — the bodies pass drains the spool in ~0.5 GB bursts, and a burst between two runs destroys the
  test's input (reviewer measured a skip, best run 2, minutes after a 914 ms pass). "Sometimes
  runs" where it used to be "never runs" is the true statement;
  (b) box 2's fix reintroduced the bug it removed — `realBodies` tops up from a second dir, and
  "largest session group" can then select the legacy residue (54 turns, best run 3) over the spool
  (47 turns, best run 40). Now selects the best RUN across all sessions; on the residue alone that
  is run=12 instead of run=3, i.e. the test runs where it would have skipped.
  Recorded here rather than in the body because a terminal card is frozen and its approval log is
  the append-only exception — and because a closed card carrying an overstated claim is exactly
  the failure mode this card was about.

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

## Acceptance (ORIGINAL — SUPERSEDED by the list above; kept as the audit trail)

Written against the false "capture is dead" premise. Two boxes survived the correction and are
resolved in the live list above; two died with the premise. Left here UNCHECKED-AS-WRITTEN on
purpose — ticking a box whose question turned out not to exist would read as work done. **The
live acceptance list is the one under `## Acceptance`, above.** A card with two lists is a card
whose "done" is ambiguous, so this heading now says which one binds.

- [~] `server status` reports body-capture state and the newest body's age → **carried forward**,
      shipped, and it is what falsified this card's own premise. See box 1 of the live list.
- [~] A decision on whether capture should be on by default, WITH the privacy consideration →
      **MOOT.** Capture is ON and producing (`newest 0s ago`); there was never a flag to flip.
      The privacy question it raised is real but belongs to whoever proposes changing the
      default, not to a card that mis-measured the current one.
- [~] The archive-pass question resolved either way → **carried forward and answered.** See box 4
      of the live list: the `.wad` archiver was retired, so there is no stalled archive pass.
- [~] Any tool answering from raw bodies degrades HONESTLY when the corpus is stale → **still
      genuinely open, and not this card's.** The `coverage.note` precedent already does this for
      dir scope (`ui.rs:2230` reports `dirsScanned`); staleness is a different axis and needs its
      own card if it is wanted.

## Notes and lessons learned

Surfaced while closing TRDD-R2VF2I53, whose test depends on this corpus. The reasoning around it
went wrong twice in opposite directions and both are worth keeping[^1]. The root cause turned out
to be a second copy of a resolution the product already owned[^2].

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

[^2]: [id: test-hardcodes-a-path-the-product-resolves status: active keywords: "real corpus test"
    "hardcoded path" "wrong directory" "measuring the wrong thing" test fixture drift spool legacy,
    ocd: 2026-08-22 lmd: 2026-08-22] DO NOT hardcode a data location in a test when the product
    itself owns a resolver for it, BECAUSE the resolver gains cases the copy never hears about
    (here: SPOOL_MODE), and the test then measures a stale location while REPORTING on the live
    one — which is worse than failing, since three sessions were spent explaining a phenomenon
    that did not exist. DO resolve through the product's own function
    (`resolveBodiesReadScope`), so a test can only ever be wrong in the same way the product is.
    Tell: the explanation for a measurement keeps needing a new story. Two wrong causes about the
    same number is the signal to check WHAT IS BEING MEASURED, not to find a third cause.
