---
trdd-id: 8ENYLEIO
title: Consume hook events in analytics — StopFailure calibrates the window, PreCompact proves compaction
column: completed
created: 2026-07-10T04:15:58+0200
updated: 2026-08-18T16:25:43+0200
implementation-commits: [ba89372]
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 4
effort: M
labels: [hooks, analytics, burn-monitor, cache-break]
parent-trdd: TRDD-Q6ZOUVK5
test-requirements: [unit, typecheck, lint]
relevant-rules: []
---

# Consume hook events in analytics

## Approval log

- 2026-08-18T13:45:00+0200 — COMPLETED under the USER "complete all TRDD" directive. Phase status,
  verified against the current codebase:
  - **Phase 1 (reader plumbing)** — delivered by later work in the direct-read form:
    `hookEventStore.readHookEvents` is consumed by burnGuard, burnInvestigator, lastCompact and the
    calibration ingest; the card's `hookEventIndex` wrapper became unnecessary.
  - **Phase 2 (window calibration)** — delivered by `src/capacityCalibration.ts`
    (`calibrateFromStopFailure`): rate-limit-class StopFailure events convert the estimated window
    ceiling into a measured one, more refined than this card asked (auth/network turn deaths are
    filtered out because they prove nothing about capacity).
  - **Phase 3 (compaction evidence)** — implemented NOW in ba89372: all three cache-break reports
    annotate COMPACTION with `causeEvidence: 'hook' | 'inferred'` from PreCompact/PostCompact hook
    events; UNCLASSIFIED breaks inside a hook window upgrade to COMPACTION/'hook'; named causes are
    never overridden; sessions without hook coverage keep the heuristic, tagged 'inferred'. 6 tests.
  - **Phase 4 (reclassify the residual)** — measured on this machine (24h corpus, 97 classified
    events): UNCLASSIFIED is 0 both with and without hook evidence — the July ~18.3% residual no
    longer exists on the current classifier, so there was nothing left to reclassify. The live hook
    store feeds the new path (208 PreCompact events, 55 sessions with windows loaded).
- 2026-08-18T16:25:43+0200 — ARCHIVED as completed (release-via: none; the code additionally
  shipped in agentlenspro@2.28.0). Release decision delegated by USER ("decide by yourself").

## Context

TRDD-Q6ZOUVK5 shipped the capture half: lifecycle hook events now land in
`~/.agentlens/hook-events/` (append-only NDJSON daily buckets) and are queryable via
`GET /api/hook-events`. Nothing reads them yet. This TRDD is the consumption half.

Two analytics surfaces currently **infer** facts that the hook events now state directly.
Inference is what makes them wrong at the margin:

1. **`burnMonitor` / `get_window_budget`** estimates rate-limit window capacity from observed
   usage. It has no ground truth for "the turn actually died on a 429". `StopFailure` is
   exactly that event, with a timestamp. Consuming it converts an estimated capacity into a
   *measured* one: the window's true ceiling is the usage accumulated at the moment the first
   `StopFailure` of that window fired.

2. **The cache-break classifier** (`cacheBreakTimeline` / `get_cache_break_causes`) infers a
   `COMPACTION` cause by prefix-diffing consecutive raw bodies and recognising the shape of a
   compacted transcript. `PreCompact` states it outright, and carries `trigger: auto|manual`.
   Consuming it turns a heuristic into evidence — and, importantly, would let the classifier
   *stop* attributing to COMPACTION the breaks that merely look like one. (Recall that the
   ~18.3% `UNCLASSIFIED` bucket in the July 2026 scan shares the hook-strip fingerprint, not
   the compaction fingerprint; exact PreCompact timestamps let the two be separated cleanly.)

Secondary, cheaper wins available from the same store:

- `SessionStart`/`SessionEnd`/`Stop` give true session lifecycle, replacing the file-mtime
  heuristic behind "is this session live?".
- The idle gap between `Stop` and the next `UserPromptSubmit`-adjacent event measures exactly
  how long a session sat idle — the input to TTL-expiry (5m/1h tier) cost analysis, which is
  currently estimated from body timestamps.
- `PermissionRequest` / `Notification` explain an idle gap as *waiting on a human* rather than
  an abandoned session — the difference between "the user walked away" and "cache expired for
  nothing".

## Plan (phases; each is independently shippable)

1. **Reader plumbing.** A small `hookEventIndex` over `readHookEvents` that answers the three
   questions the analytics need, bounded and cached per scan:
   `stopFailuresIn(window)`, `compactionsIn(session)`, `idleGapsIn(session)`.
2. **Window calibration.** `burnMonitor` consumes `StopFailure`: when one exists inside the
   current window, report the observed ceiling as **measured** (with the event's timestamp as
   provenance) instead of estimated. The status object must distinguish the two — never present
   a measured ceiling and an estimated one as the same field (fail-honest, per the existing
   `coverage.complete` precedent in the leaderboard tools).
3. **Compaction evidence.** The cache-break classifier consumes `PreCompact`/`PostCompact`: a
   break whose timestamp falls between a `PreCompact` and the following `PostCompact` is
   `COMPACTION` with `evidence: hook`; the existing prefix-diff heuristic stays as the fallback
   for sessions with no hook coverage, tagged `evidence: inferred`.
4. **Reclassify the residual.** With compaction now positively identified, re-run the
   break-cause classification over a corpus and check whether the `UNCLASSIFIED` share drops
   into `HOOK_INJECTION` as predicted. If it does, that is the empirical confirmation of the
   mechanism described in yvgude/lean-ctx#778 and Emasoft/ai-maestro-janitor#79.

## Constraints

- **Hook coverage is optional.** Every consumer must degrade cleanly when the store is empty
  (a user who never ran `--install-hooks`): fall back to the current inference, and say so in
  the output. No consumer may hard-depend on hook events.
- **Never silently re-label history.** A break classified `COMPACTION` by hook evidence and one
  classified by prefix-diff must be distinguishable in the output, or the next investigation
  cannot tell measurement from guess.
- Bounded reads only — `readHookEvents` caps at 1000 records per call by design; a scan must
  not loop it unboundedly across buckets.

## Verification

- Unit tests with a seeded tmpdir store: a `StopFailure` inside the window flips the ceiling to
  measured; absent hooks keep the estimated path byte-identical to today's output.
- A break inside a Pre/PostCompact bracket classifies as `COMPACTION` + `evidence: hook`; the
  same break with the store empty classifies exactly as it does today.
- `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit` (Node 18/20 — mocha 10 crashes
  on Node 26 in its own yargs bootstrap; unrelated to this work, see the note below).

## Notes

- Known environment defect, not caused by this TRDD: `pnpm run test:unit` fails on Node 26
  (`mocha@10.8.2` → bundled `yargs@16` → `ReferenceError: require is not defined in ES module
  scope`). CI pins Node 18/20, where it passes. Fixing it means bumping mocha, a dependency
  change deliberately left out of scope here.
