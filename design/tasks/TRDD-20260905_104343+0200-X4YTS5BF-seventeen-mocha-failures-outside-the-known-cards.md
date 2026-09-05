---
trdd-id: X4YTS5BF
title: The full mocha suite has 17 failures and only 7 of them belong to an open card
column: todo
created: 2026-09-05T10:43:43+0200
updated: 2026-09-05T10:43:43+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
related: [B7DSTJLS, CS2W7E77, U0L78B3Z]
---

# The full mocha suite has 17 failures and only 7 of them belong to an open card

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T10:43:43+0200

Measured 2026-09-05 10:27–10:42 local, `npx mocha` over the whole `out/test` tree (the two file
arguments were ignored by the mocharc spec — the run was the full suite, 15 min):
**2643 passing · 10 pending · 17 failing**. Raw output: `reports_dev/fgn5ty7e-mocha2.txt`.
The tree under test carried only the TRDD-U0L78B3Z / FGN5TY7E edits (`serverControl.ts` types,
Rust files mocha never loads); none of the 17 touch those, and the capture-line suites pass.

| # | failing describe | error | owned by |
|---|---|---|---|
| 1–2 | `cacheBreakTimeline — buildCauseCostPeakReport` / `real machine data` | Timeout 120 s / 240 s | TRDD-B7DSTJLS |
| 3 | `FAL Phase 1 — 🐌 real machine data` | Timeout 180 s (`forensicsIndex.test.js`) | **nobody** |
| 4 | `rustIngest — P3b OTLP transform parity` | Timeout 30 s | **nobody** |
| 5–9 | `standalone server — P5 window auto-calibration (real boot, real ingest path)` ×5 | `ENOENT …/home/.agentlens/burn-config.json` | TRDD-CS2W7E77 |
| 10–14 | `setup — virgin HOME full converge (real server on ephemeral ports)` ×5 | `ENOENT …/.claude/skills/agentlenspro-diagnostics/SKILL.md` | **nobody** |
| 15–16 | `setup — repair matrix (broken fixtures, real converge)` ×2 | (read the file) | **nobody** |
| 17 | `setup — fail-fast refusals (no silent continue)` | (read the file) | **nobody** |

**The eight `setup` failures are the ones that matter for the goal** ("the package is always
updated, published and running the latest version"): `agentlenspro setup` in a virgin HOME cannot
install the diagnostics skill (`SKILL.md` missing at the expected path). If that reproduces on a
fresh install it is a shipping defect, not a test defect. Not yet established which — the ENOENT
could be the test fixture's expectation of an old skill path, or `setup` writing it elsewhere.

**Why this card and not silence:** the previous session's board carried these as "pre-existing
flakes" in prose. B7DSTJLS's lesson applies verbatim — "a flake fails intermittently on the same
input; this fails deterministically". Every row above is an ENOENT or a timeout at the mocha
default, reproducible on this tree.

## Acceptance

- [ ] `setup` ×8: root cause named from the raw output (fixture path vs product path), fixed in
      whichever side is wrong, and the eight tests green on a real ephemeral-HOME run.
- [ ] `rustIngest — P3b` and `FAL Phase 1`: either fixed or their timeouts are `loadScaledTimeout`
      like their neighbours, with the measured runtime on this machine recorded here.
- [ ] Rows 1–2 and 5–9 stay with their owning cards; this card links, never duplicates.
- [ ] A full-suite run recorded here with the failing count, so the next reader does not start
      from "17".

## Notes and lessons learned
