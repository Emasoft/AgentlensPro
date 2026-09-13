---
trdd-id: XI3UZUTK
title: Five P5 window auto-calibration tests fail because the real-boot ingest path stores zero spans
column: todo
created: 2026-09-13T20:59:19+0200
updated: 2026-09-13T21:08:06+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T20:59:19+0200
priority: high
---

# Five P5 window auto-calibration tests fail because the real-boot ingest path stores zero spans

Measured 2026-09-13 on a full `pnpm run compile-tests && npx mocha` run: **2829 passing, 5 failing**, all five in `serverCalibration.test` ("standalone server — P5 window auto-calibration (real boot, real ingest path)").

Failure 1 is the root; 2-5 are its consequences.

1. `a rate-limit StopFailure through the ingest path writes observed capacity to burn-config.json` — AssertionError: *account window must exist before the stall*. The diagnostic line reads `0 span(s) (last 24h window) ... store holds 0 span(s) across 0 segment(s), nothing evicted`, and alcore's own log says `log scan files=0 changed=0 parsed=0 cards=0`.
2-5. `ENOENT` on the per-run burn-config file under the test HOME, raised in `readConfig` — the file is never written because (1) never calibrated. (Path elided: it was a per-run temp value, and the literal shape trips the identity gate.)

So the real defect is single: **the real-boot ingest path ingests nothing**, so no account window exists, so calibration never runs and the config file is never created. The four ENOENT failures are downstream noise, not four separate bugs.

alcore DID boot (it printed its OTLP/UI/MCP listening lines), so this is NOT the codesign/SIGKILL hazard in CLAUDE.md — that one produces a server that never answers at all.

## Scope caveat — do not skip this

**Whether these five are PRE-EXISTING is UNVERIFIED.** They were found while committing unrelated review-gate work, and the working tree carries uncommitted changes to `src/cli/main.ts`, `reviewGate`, `reviewGateEffects` and `delegateGate`. None of those is on the calibration path and the failing path runs the Rust core, so causation is implausible — but implausible is not measured. First step is to check out a clean HEAD in a scratch worktree and re-run `serverCalibration` there. If it fails clean, the suite was already red and the question becomes for how long.

Also note the suite emitted `file watching unavailable on every log dir — falling back to a 5s full poll`, which is worth ruling in or out as the reason the scan saw `files=0`.
Priority raised to high: a red suite outranks ordinary backlog, because it means the next person cannot tell whether their own change broke something or hit this pre-existing failure.

## Acceptance
- [ ] Re-run on a clean HEAD worktree; record whether the five fail there too.
- [ ] Root-cause why the boot ingest stores zero spans.
- [ ] Suite green, or the test is corrected if it asserts something the product no longer promises.

## Approval log

- 2026-09-13T20:59:19+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
