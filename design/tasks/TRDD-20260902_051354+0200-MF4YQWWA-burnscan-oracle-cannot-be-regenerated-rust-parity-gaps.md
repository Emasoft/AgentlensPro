---
trdd-id: MF4YQWWA
title: The burnscan TS oracle can no longer be regenerated — Rust investigate_burn is behind it on captureGaps and on the sonnet-5 scheduled price
column: todo
created: 2026-09-02T05:13:54+0200
updated: 2026-09-02T05:13:54+0200
current-owner: unassigned
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: DMWOBWFH
min-approval-requirement: none
priority: high
blocked-by: []
implementation-commits: []
---

# The burnscan TS oracle can no longer be regenerated — Rust investigate_burn is behind it on captureGaps and on the sonnet-5 scheduled price

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

- [ ] Rust `investigate_burn` emits `coverage.captureGaps` and the `note` suffix byte-identical to
      the TS oracle for every fixture case (port the TRDD-4FMHW124 logic; TS is the spec).
- [ ] The scheduled-price divergence is settled with evidence: which side applies
      `scheduledChange` by wall clock, why the other is right, and the wrong side fixed. If TS is
      wrong it is fixed in `src/shared/pricing.ts`'s lookup (the oracle must be deterministic
      across regeneration dates); if Rust is wrong, `pricing.rs`.
- [ ] `node gen-burnscan-expected.mjs` regenerated from a clean tree, committed with ZERO hand
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
