---
trdd-id: MF4YQWWA
title: The burnscan TS oracle can no longer be regenerated — Rust investigate_burn is behind it on captureGaps and on the sonnet-5 scheduled price
column: complete
created: 2026-09-02T05:13:54+0200
updated: 2026-10-04T12:40:19+0200
current-owner: claude-session-2026-09-02
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: DMWOBWFH
min-approval-requirement: none
priority: high
blocked-by: []
implementation-commits: [532baacb]
status: archived
---

# The burnscan TS oracle can no longer be regenerated — Rust investigate_burn is behind it on captureGaps and on the sonnet-5 scheduled price

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

All 3 boxes CONFIRMED by the reviewing agent: `captureGaps` ported, per-response ts pricing at
every call site in BOTH languages, and a **live regeneration performed today** yielding a
zero-diff fixture, 9/9 parity, 18/18 mocha, clippy clean. Report:
`reports/ai-review/20260905_075655+0200-MF4YQWWA.md`.

**Why the zero-diff regen is the right evidence, and a green parity run alone would not have
been.** A parity test can pass because the golden was regenerated in the same commit as the code
it checks — the fixture and the implementation drift together and the assertion never notices.
The discriminator is that the golden is ALREADY IN THE REPO and untouched. **Split by who
established what** — and the split is per CLAUSE, not per sentence:

- **ORCHESTRATOR (observed):** `tests/fixtures/burnscan-expected.json` is unmodified in the working
  tree and was committed before this session. So whatever the suite asserts against, it is a
  golden nobody touched. **That, alone, is what the drift trap needed** — and it is a question
  about the fixture's PROVENANCE, which a source-level check can settle and a test result cannot.
- **REVIEWING AGENT (reported):** that the suite passes (9/9), that mocha is 18/18 and clippy
  clean, and that a regen ran today with zero diff. A clean tree is equally consistent with a
  regen that ran and matched, one that wrote nothing, and one that never ran — so the tree
  corroborates this report, it does not prove it. What makes it credible is that those results are
  outputs nobody obtains from a tree they never touched.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-02

**LANDED, all three boxes, → ai_review.** Box 2's root cause was NOT "one side applies the
scheduled rate by wall clock" — BOTH investigators omitted the call's timestamp at every
`calcTokenCostUsd` / `calc_token_cost_usd` site, so both priced at "now"; the committed oracle only
looked stable because it predated the 2026-09-01 boundary. Fix on both sides: price each response
at its own `iso(ts)` and sum per model (never re-price the aggregated bucket). Determinism proven:
a clean regen today reproduces the originally committed totals (main 2.87, clampedHigh 9.12, idle
0.31), and a two-response window straddling 2026-09-01 totals $25 ($10 + $15) on both sides —
`src/test/burnInvestigator.test.ts` and `investigator_scan.rs::tests`. `captureGaps` ported
(`find_capture_gaps`, skipped when blind or file-capped, same reason as TS). `pricing.json`
re-exported (`lastUpdated` 2026-09-01, adds `claude-fable-5-1`). Oracle regenerated with zero hand
edits. Gates: `burnscan_parity` 9/9, mocha burnInvestigator 18/18, clippy 0, check-types 0,
check-mirrors 0, check-pricing-export 0. Report:
`reports/MF4YQWWA/20260902_060917+0200-oracle-regen-parity.md`. CI gap → proposal TRDD-I5O38KKP.

## The defect (VERIFIED first-hand, 2026-09-02, while landing TRDD-YBJGIYI1)

`rust-core/crates/agentlens-core/tests/fixtures/gen-burnscan-expected.mjs` is the sanctioned way to
produce `burnscan-expected.json`: it runs the compiled TS `investigateBurn` over the fixture bodies
and writes what it returns. Running it today on an otherwise-green tree turns `burnscan_parity`
red — 6 of 9 tests — because the TS oracle now emits two things the Rust port does not:

1. **`coverage.captureGaps` (+ the `CAPTURE GAP: …` suffix on `coverage.note`)** — shipped on the
   TS side by TRDD-4FMHW124 (archived `complete`) and never ported to
   `rust-core/crates/agentlens-core/src/burn/investigator_scan.rs` (zero occurrences of
   `captureGaps` there). Every fixture case with hook events in the window gains a
   `captureGaps[]` array in the oracle; Rust emits the key set without it.
2. **`totals.estCostUsd` for `claude-sonnet-5`** — the oracle now prices the 2026-08-20 fixture
   window at the post-`scheduledChange` sticker (main `0.08 → 0.13`, idle `0.31 → 0.46`), Rust
   still at the introductory rate the committed oracle was generated with. `src/shared/pricing.ts`
   carries `scheduledChange: { from: '2026-09-01' … }` on that row, and Rust reads the same table
   through `pricing.json`, so the divergence is in HOW the scheduled rate is applied — one side by
   the request timestamp, the other by the wall clock. Which side is wrong is the first thing to
   settle; a cost for a 2026-08-20 request should not change because today is 2026-09-02.

Consequence: the oracle is frozen at the commit that last regenerated it. TRDD-YBJGIYI1 had to
restore `burnscan-expected.json` from HEAD and hand-apply the two byte deltas its new storm bodies
caused (`600513 → 600681`, `bytesSent` + `bytesOnDisk`), because the generator's full output would
have committed drift Rust cannot reproduce. That is a hand-edited oracle, exactly what the
generator exists to prevent.

## Acceptance

- [x] Rust `investigate_burn` emits `coverage.captureGaps` and the `note` suffix byte-identical to
      the TS oracle for every fixture case (port the TRDD-4FMHW124 logic; TS is the spec).
- [x] The scheduled-price divergence is settled with evidence: which side applies
      `scheduledChange` by wall clock, why the other is right, and the wrong side fixed. If TS is
      wrong it is fixed in `src/shared/pricing.ts`'s lookup (the oracle must be deterministic
      across regeneration dates); if Rust is wrong, `pricing.rs`. — BOTH sides were wrong, at the
      investigator call sites, not in the lookups; see STATE.
- [x] `node gen-burnscan-expected.mjs` regenerated from a clean tree, committed with ZERO hand
      edits, and `cargo test -p agentlens-core --test burnscan_parity` exits 0 on it.

## Evidence

- This session's failing run (first regen, before the fix on YBJGIYI1's side):
  `full_report_reproduces_the_ts_oracle_exactly` — `main.coverage: key set/ORDER differs`,
  got 7 keys, expected 8 (`captureGaps`).
- Per-case leaf diff HEAD vs regenerated: every case gains `captureGaps`; `main`, `clampedHigh`,
  `idle` also move `totals.byModel[*].estCostUsd` for `claude-sonnet-5`.

## Approval log

- 2026-09-02T05:13:54+0200 — Filed by the session landing TRDD-YBJGIYI1, from the parity run it
  broke and the diff that explained it. Tier 0 (own scope, Rust parity work under DMWOBWFH).
- 2026-09-24T08:57:36+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
2026-09-24T09:17:06+0200 — AI re-review at HEAD 3faa709c: acceptance still holds — later commits 897f51eb/f7610871/8f00e737 only changed the sonnet-5 rate VALUE (withdrawn scheduledChange removed, pricing.json re-exported), not the per-response-timestamp pricing mechanism this card fixed; cargo test -p agentlens-core --test burnscan_parity 9/9 pass at HEAD; mocha burnInvestigator.test.js suite green (2840 passing incl. all burnInvestigator/pricing cases, 7 unrelated failures in reviewLoop/serverCalibration env-only tests).
- 2026-10-04T12:40:19+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". Independent verification 20261004_123724+0200-close-verify-cv1.md, HEAD 7dab99a0: burnscan_parity ok 9 passed against the committed golden, captureGaps read at investigator_scan.rs; boxes 2 and 3 (scheduled-price divergence settled, zero-diff regeneration) rest on recorded one-time evidence, the regeneration was not rerun..
