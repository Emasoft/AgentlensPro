---
trdd-id: X4YTS5BF
title: The full mocha suite has 17 failures and only 7 of them belong to an open card
column: dev
created: 2026-09-05T10:43:43+0200
updated: 2026-09-05T12:33:51+0200
implementation-commits: [f3235678, 244fbfef]
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
related: [B7DSTJLS, CS2W7E77, U0L78B3Z]
---

# The full mocha suite has 17 failures and only 7 of them belong to an open card

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T12:33:51+0200

**IN `dev`, fixes COMMITTED, full-suite run (box 4) in flight.** Root cause of the eight `setup`
failures, from `reports/x4yts5bf/20260905_122349+0200-repair-matrix-hook-hang.md` and verified at
both code sites: the hooks step's verify exec inherited the caller's HOME and never set
`AGENTLENS_DATA_DIR`, so every hook the tests spawned resolved the REAL machine's `~/.agentlens`
(pidfile, daemon-revive lock, hook-spool); a failed POST then revived against the live pidfile,
which ran an UNBOUNDED synchronous `ps` in `processStartRef`. Fix `244fbfef`: pin `HOME` and
`AGENTLENS_DATA_DIR` to the ctx (byte-equivalent in production), 5 s timeout on the `ps` call
(null = cannot verify = the conservative rule), ceiling back to 15 s. Measured: the five setup +
runtime suites, 89 passing in 11 s at load 27 — including the repair-matrix suite that hit
ETIMEDOUT at a 60 s ceiling an hour earlier. The `ps` stall as the mechanism is inferred (not
reproduced); the leak is verified and the hang is bounded either way. Rows 3–4 are `f3235678`
(P3b load-scaled at 30 s, FAL 400 s behind `skipIfUnmeasurable`). Remaining: box 4's full-suite
count (`reports_dev/x4y-full-suite.txt`) → then `ai_review`.

**Established earlier (each first-hand or from a report whose cited lines were re-read):**
- The eight `setup` failures are ONE cause: the `hooks` step's verify exec
  (`src/cli/setup.ts` `execRegisteredCommand`, `spawnSync … timeout`) returns `ETIMEDOUT` and
  fail-fast turns it into SKIP cascades (`reports/x4yts5bf/20260905_115152+0200-*.md`). The
  virgin-HOME suite passes in isolation (4/4 runs); the bare shim boots in 0.14 s at load 18.
- BUT the `repair matrix` suite still hits `ETIMEDOUT` in isolation with the ceiling raised to
  60 s (`reports_dev/x4y-setupverb.txt`, 16 pass / 3 fail, all three the same cascade). So the
  exec'd command genuinely hangs past its own 2 s budget in that fixture — the contention story
  covers the virgin suite only. Root cause pending (debug agent, report under `reports/x4yts5bf/`).
- Rows 3–4: P3b's `alingest` child runs in 0.00 s on an empty payload and the fixture is two
  spans, so the 49 s wall is on the TS side or the harness, not the Rust binary — a base raise
  (120 s) would hide it; NOT committed until explained. FAL's 198 s at the 180 s floor: the
  bodies dir readdir returns 0 entries, so the per-entry term is inert and the time is elsewhere.
- Uncommitted worker edits in the tree: `setup.ts` ceiling 15 s → 60 s (keep: the never-hang
  guard, measured harmless), `rustIngest.test.ts` / `forensicsIndex.test.ts` load-scaled + bases
  raised (hold until the slow side is named).
- `check-identities` flagged this card's own row 5–9 (`/home/…` from a test's ephemeral HOME);
  rewritten as `<tmpHOME>` — the guard is shape-based and a tmp HOME looks like a home path.

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
| 5–9 | `standalone server — P5 window auto-calibration (real boot, real ingest path)` ×5 | `ENOENT <tmpHOME>/.agentlens/burn-config.json` | TRDD-CS2W7E77 |
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
