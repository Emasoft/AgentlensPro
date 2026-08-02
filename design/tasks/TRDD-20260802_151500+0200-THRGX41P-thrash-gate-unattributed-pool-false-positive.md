---
trdd-id: THRGX41P
title: THRASH_ACTIVE false positive — unattributed cold starts pool into one phantom source and deny unrelated launches
column: todo
created: 2026-08-02T15:15:00+0200
updated: 2026-08-02T15:15:00+0200
current-owner: claude-code
task-type: bugfix
severity: MEDIUM
labels: [burn-gate, agent-gate, attribution, false-positive]
relevant-files: [src/bodiesActivity.ts, src/agentGate.ts]
release-via: publish
---

# THRASH_ACTIVE false positive — unattributed pooling

## The incident (2026-08-02, reported by the owner from the janitor's session)

The burn-gate denied a `fable-advisor:advisor` spawn with `THRASH_ACTIVE`: "5 calls in the last
5min re-WROTE ~1179k tokens of prefix (model claude-fable-5). Likely source: session 0a6debe9…
(claude-opus-5, 52 fat requests ~48.2MB)". The janitor's Claude verified the writes were real but
found the named source wrong — its own session was the top sender, and the detectors attributed
only 14% of the window.

## Three verified defects

1. **The unattributed group can flip `active`.** `ThrashReport.topSource` documents it itself:
   "null session = the unattributed group; active keys off THIS group's count". Attribution runs
   on the `previous_message_id` chain, which is measured mostly dead (0/3 sampled requests had a
   successor call — CLAUDE.md; 14% attribution in the incident). So N DISTINCT fresh agents'
   one-time cold-start prefix writes (~236k each — the measured lean-subagent boot) pool into the
   null group, cross `thrashMinCount` (3), and read as ONE session thrashing. The 2026-07-11
   false-positive fix (`coldStartSessions`) protects exactly this shape — but only for ATTRIBUTED
   writes. 5 × ~236k in 5min = a normal advisor/worker launch sequence, not thrash.
2. **Suspects ignore the model.** `suspects` = concurrent fat-request senders, unfiltered — the
   incident deny named an opus-5 session as the likely source of fable-5 thrash. A source whose
   model differs from `thrash.model` cannot be the prefix-mutating caller; the message printed a
   self-contradiction without noticing.
3. **The deny is broader than the causal claim.** "Launching more agents multiplies the
   re-billing" is true for FORKS and resumes into the thrashing prefix; a fresh non-fork agent
   pays only its own boot prefix and multiplies nothing. Denying a read-only advisor neither
   stops the thrash nor protects the window — and blocks the consultation that might diagnose it.
   (The keep-warm pinger already has a carve-out; the same reasoning applies wider.)

## Proposed fix (decide with the owner before implementing)

- `active` requires `topSource.session !== null`. The null group instead feeds an ADVISORY
  ("N big unattributed cold writes in {window} — possible thrash, possible fan-out boot; run
  investigate_burn"), mirroring the existing FAN_OUT_COLD_START advisory.
- Filter `suspects` to senders whose model matches `thrash.model`; when none matches, print the
  honest "Source not attributable" arm instead of a wrong name.
- Under THRASH_ACTIVE, keep DENY for forks, resumes (SendMessage to dead agents), and launches
  from the thrashing session itself; downgrade fresh non-fork launches from other sessions to a
  WARN carrying the same evidence.
- Regression tests: pooled-unattributed cold starts do NOT flip active; model-mismatched suspects
  are dropped; a fresh non-fork launch under thrash gets warn, a fork gets deny.

## Evidence

- Detector: `src/bodiesActivity.ts` (`ThrashReport`, thresholds cc>100k, read-share<0.25,
  count≥3/5min); gate: `src/agentGate.ts:245` (deny), `:144` (`thrashSource`).
- Falsifier at incident review time: `statusline-history cache` shows the machine's real chronic
  cold-writers are an opus-5[1m] fleet (0a6debe9 at ~500–600k×92% write repeatedly) — spaced ~
  hourly, NOT 5-in-5min; nothing matches a fable-5 same-session 5×236k thrash except a pooled
  fan-out boot sequence.

## Notes and lessons learned

## Approval log
- 2026-08-02 — filed from the owner's report + first-hand code/measurement verification; queued
  at todo per the new-directive rule (assessment delivered, fix awaits the owner's call on the
  policy points above).
