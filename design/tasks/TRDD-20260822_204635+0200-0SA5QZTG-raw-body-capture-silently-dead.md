---
trdd-id: 0SA5QZTG
title: Raw body capture has been dead for days and nothing noticed
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
