---
trdd-id: FGN5TY7E
title: The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree
column: testing
created: 2026-09-05T08:25:46+0200
updated: 2026-09-05T16:48:00+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
created-by: U0L78B3Z
related: [U0L78B3Z, ZIWEB0UW, 8ADTIGKT]
implementation-commits: [0c01a3e1, 7659b9ca]
---

# The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T16:48:00+0200

**`ai_review` → `testing` (REJECTED 16:46, accepted by the orchestrator).** Boxes 1–2 verified met by
the review; box 3 is PARTIAL by the card's own 11:21 STATE and its mutation run — delete a field from
the emitter in `server_stats.rs`, confirm the frozen-shape test in `tests/server_stats.rs` goes red,
restore — was never performed, so the card moved toward `human_review` ahead of its own stated gate.
No code is pending; the deliverable is that test run, hence `testing` rather than `dev`.
`implementation-commits` was `[a55074bd]` — TRDD-U0L78B3Z's fix commit, not this card's — corrected to
`[0c01a3e1, 7659b9ca]` (the dedup refactor and the review-correction commit, the only two code commits
tagged FGN5TY7E; checked with `git log --grep`). **NEXT ACTION:** run the box-3 mutation when the
machine is free (a Rust build shares the CPU today), record the red/green pair with the command and
date, decide box 4 (partial by design, or a follow-up card), then `testing → ai_review`.

## STATE — 2026-09-05T11:21:29+0200 — HISTORICAL

**DONE in the working tree (uncommitted, same gate as TRDD-U0L78B3Z: `reports_dev/diz-final.txt`).**
`src/cli/serverControl.ts` now has ONE `export interface ServerStatsBodies`; `ServerStats.bodies`
uses it and `bodiesCaptureLine` takes a `Pick<>` of it (a projection, not a second declaration).
The unread `spool?` was dropped rather than half-typed. Box by box:
- Box 1 met. Box 2 met: the tree-wide shape grep (`bodies\s*\??:\s*\{` over `src`, `media/src`,
  `standalone`, tests excluded) found exactly the two declarations, both in `serverControl.ts`;
  `burnGuard.ts:110` is a `BurnGuardOptions` parameter member; `media/src` has zero.
- Box 3 PARTIAL (review fork 2026-09-05, `reports/review-fork/20260905_114745+0200-*.md` §1 —
  corrected after commit 0c01a3e1 claimed "met"): `tests/server_stats.rs` freezes the EMITTER's
  key set only; it cannot see the TS interface, and the two sets already differ (the interface
  declares unsent `reclaimedSinceBoot`/`lastNonZeroPassAt`; the emitter sends undeclared `spool`).
  A consumer-side drift is caught by nobody. The comments in both files now say so instead of
  claiming a gate. The other half (a TS test parsing the `json!` keys) is YAGNI until a second
  drift appears. The "delete a field and confirm red" mutation was argued, not RUN — run once
  before `human_review`.
- Box 4 PARTIAL, deliberately: `captureDownSince`/`sinkProblem` now send (U0L78B3Z);
  `reclaimedSinceBoot`/`lastNonZeroPassAt` stay declared-but-unsent because the bodies purge that
  produces them is unported and the CLI's fallback rendering is honest about absence.
**NEXT ACTION:** commit with U0L78B3Z; run the box-3 mutation once; then `human_review` is the
USER's move. (Originally: "Nothing fixed; this card is the finding.") Column history: moved
`todo → ai_review` directly on 2026-09-05 — the one-file change was done inside U0L78B3Z's session
and its gate is that card's frozen-shape test, so no `dev`/`testing` interval was ever recorded;
an exempt mechanical move, noted here rather than in an approval log it does not belong in.

`/api/server-stats`'s `bodies` object is produced by ONE literal `json!` block in
`server_stats.rs` and consumed through **at least two separate hand-written TypeScript declarations
in one file**, which disagree (why "at least" is the honest word: see the floor note below):

| declaration | declares | omits |
|---|---|---|
| `interface ServerStats.bodies` — `serverControl.ts:575-588` | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt, captureDownSince, sinkProblem, live | **parked, spool** |
| `bodiesCaptureLine`'s parameter — `serverControl.ts:509-514` | live, parked, captureDownSince, sinkProblem | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt |

Nothing reconciles them with each other or with the emitter. The CLI demonstrably reads
`s.bodies.parked`, which its own main interface does not declare.

**`burnGuard.ts:110` is NOT a third declaration — corrected before this card was a day old.** It
carries `captureDownSince?: number | null`, but it is a member of `BurnGuardOptions`, the parameter
type of `checkBurnRisk(opts)` — a function contract that is HANDED the value (by
`mcpServer.ts:3845` via `getCaptureDownSince?.()`), not a parse of the wire object. Its own doc
comment says so: *"server-injected … the guard cannot derive this from disk"*. This card's first
version counted it as a third declaration from a single grep hit line that was never opened in
context, and put "three times in two files" in the TITLE. **A grep hit proves a field is declared
somewhere; it says nothing about what type declares it or what else that type contains.** The
count matters because it sizes the work: two shapes in one file is a local dedup, three across two
files would have been a reconciliation.

**TWO IS A FLOOR, and the search that found it says why.** Every hit for the four field names
across `src/`, `media/src/`, `standalone/` (tests excluded) is now classified:

| file | hits | what it is |
|---|---|---|
| `src/cli/serverControl.ts` | 11 | the TWO declarations above, plus reads |
| `src/burnGuard.ts` | 6 | `BurnGuardOptions` member + uses — a parameter contract, NOT a wire declaration |
| `src/mcpServer.ts` | 1 | `getCaptureDownSince` — the supplier callback, declared and called, never supplied |
| `standalone/cli.js` | 3 | **BUILD ARTIFACT — measured, not assumed**: esbuild preamble (`var __create = Object.create;` …), 15,266 lines, and gitignored. Never count a bundle as a declaration |
| `media/src/` | 0 | no hit for these names (`--include=*.ts,*.tsx`, which is what the dashboard is written in) |

**But that search keys on FOUR FIELD NAMES, so it cannot see a declaration that omits all four** —
e.g. one declaring only `archive`/`lastPass`/`live`/`parked`. Given the two known shapes each omit
half the fields, a third partial shape omitting all four is exactly what this codebase produces.
The zero in `media/src/` is likewise weak: it means no declaration there names these four, not that
none exists (the dashboard consumes state over the message protocol rather than this endpoint —
plausible, unchecked). Acceptance box 2 exists to settle the total; widen by SHAPE, not by field
name: `grep -rn 'bodies\s*[?]\?:\s*{' --include=*.ts src/ media/src/`. The asymmetry protects the
card — every miss ADDS a declaration, so the fix only grows.

**Why this is its own card and not part of U0L78B3Z.** U0L78B3Z is "the Rust writer was never
ported for four fields" — a porting job. This is "one wire object has two partial hand-maintained
shapes and nothing checks either against the producer" — a structural one. Fixing all four fields
touches none of this, and the duplication keeps producing that class afterwards. `related:`, not
`eht:`: the port does not depend on the dedup, and the dedup must not block the port.

**Why it is high priority despite being a refactor.** It is the mechanism by which
TRDD-U0L78B3Z's defects stayed invisible: each declaration looks locally complete, so a reader
checking one has no signal that another exists or that the producer never sends the field. Two
silent alarms (`CAPTURE DOWN`, `SINK:`) survived months this way.

**How it was found — the method generalises.** Not by reading TypeScript, but by diffing the
CONSUMER's declared fields against the PRODUCER's emitted key set. The emitted set is closed by
reading the one literal block that builds the section; the consumed set needs every declaration,
which is why the count of declarations matters. A dot-access grep is a lower bound and cannot see
a parameter read — it could not see `serverControl.ts:521`, the read TRDD-U0L78B3Z is about.

## Acceptance

- [ ] ONE declaration of the server-stats `bodies` shape, or a generated/shared type, consumed by
      every reader (`serverControl.ts` ×2 today, plus any found by the search below).
- [ ] A search establishes the FULL declaration set FIRST — `grep -rn` for the field names across
      `src/`, `media/src/`, `standalone/`, and **open every hit to see what type it belongs to**.
      This card's first version counted `burnGuard.ts:110` as a third declaration from an unopened
      grep line; it is a `BurnGuardOptions` parameter member. Record the number found AND what each
      hit turned out to be — a hit is a field name, not a declaration of this object.
- [ ] Something FAILS when producer and consumer diverge: a test that asserts the declared shape
      against a real `/api/server-stats` response, so a field declared-but-never-sent is caught by
      CI rather than by a human noticing a row that never renders. Mutation-verified — delete a
      field from the emitter and confirm it goes red.
- [ ] The four fields from TRDD-U0L78B3Z either send or stop being declared; no declaration
      survives that describes a field nothing emits.

## AI review verdict — 2026-09-05T16:46:33+0200

| box | met/unmet/unmeetable | status | evidence |
|---|---|---|---|
| 1. ONE declaration of `bodies` | met | ✓ VERIFIED | `git show 0c01a3e1 -- src/cli/serverControl.ts`: `ServerStats.bodies` interface + `bodiesCaptureLine`'s param collapsed into ONE `export interface ServerStatsBodies` (line 511) + a `Pick<>` at line 532/589. Current file confirmed: only one `interface.*Bodies` hit in `serverControl.ts` (`grep -n`). |
| 2. Search establishes full declaration set | met | ✓ VERIFIED | Re-ran the shape grep myself (`bodies\s*[?]\?:\s*{` and `Bodies` name grep) over `src/`, `media/src/`, `standalone/` (`--include='*.ts'`): only `ServerStatsBodies` in `serverControl.ts` matches the server-stats wire shape; the other 4 `*Bodies` interfaces (`BodiesReadScope`, `BodiesActivityReport/Options`, `LiveBodiesScan`) are unrelated shapes, not competitors. `media/src` = 0, matching the card's claim. |
| 3. Something FAILS on producer/consumer divergence, mutation-verified | unmet | ✗ UNVERIFIED | `git show 7659b9ca -- rust-core/.../tests/server_stats.rs`: comment now says the test freezes the EMITTER's key set only and "cannot see" the TS interface — the card's own review-fork (`reports/review-fork/20260905_114745+0200-diz-u0l-fgn-review.md` §1) downgraded this to PARTIAL. `reports_dev/review-fix-gate.txt:124-131` shows the test PASSING (green), but the required mutation ("delete a field from the emitter and confirm it goes red") was never run — STATE block says so explicitly ("argued, not RUN — run once before human_review"). Deferred here too (CPU contention forbids me running `cargo test`), but the card's own NEXT ACTION names this as the step still outstanding, and it was not done before the column move. |
| 4. The four TRDD-U0L78B3Z fields send or stop being declared | unmet (partial, reasoned) | ✓ VERIFIED (as partial) | `grep -n "reclaimedSinceBoot\|lastNonZeroPassAt\|captureDownSince\|sinkProblem" rust-core/.../src/server_stats.rs`: emitter sends `captureDownSince`/`sinkProblem` (line 676-682) but never `reclaimedSinceBoot`/`lastNonZeroPassAt`. `curl -s localhost:3000/api/server-stats` on the LIVE server confirms the same key set: `['archive','captureDownSince','lastPass','live','parked','sinkProblem','spool']` — no `reclaimedSinceBoot`/`lastNonZeroPassAt`. The interface still declares both as optional with a comment naming the unported purge as the reason (consistent with the card's stated rationale) — so the claim "2 of 4 fixed, 2 deliberately left declared-but-unsent" is accurate, but the acceptance box's literal text ("no declaration survives that describes a field nothing emits") is not met. |

**Frontmatter defect:** `implementation-commits: [a55074bd]` is WRONG for this card — `a55074bd` is TRDD-U0L78B3Z's own fix commit (`git log -1 a55074bd`: "compute captureDownSince and probe the bodies sink … (TRDD-U0L78B3Z)"). This card's actual implementing commits are **`0c01a3e1`** (the dedup) and **`7659b9ca`** (the review-fork correction that downgraded box 3 to PARTIAL). `git log --all --grep="FGN5TY7E"` confirms these two plus four `docs(board)` commits (card authoring, not implementation). Neither `0c01a3e1` nor `7659b9ca` appears in `implementation-commits:` — the backtracking field currently points at the wrong card's commit entirely.

**Defects found:**
1. Box 3's acceptance text requires "Mutation-verified" and the card's own STATE names the mutation run as the outstanding NEXT ACTION, not yet performed — moved toward `human_review` before its own stated gate.
2. `implementation-commits:` frontmatter cites `a55074bd` (a different card's commit) instead of this card's actual `0c01a3e1`/`7659b9ca`.

Boxes 1 and 2 are genuinely done and well-evidenced. Box 4's partial state is honestly reported and reasoned (scope boundary vs. an unported purge), which is exactly the kind of judgment call `human_review` exists for. Box 3's gap is smaller in scope — one `cargo test` mutation run — but it is the card's own self-identified last step, skipped.

**Verdict: REJECT — run the box-3 mutation (delete a field from the emitter, confirm the frozen-shape test goes red) and fix `implementation-commits:` to `[0c01a3e1, 7659b9ca]` before resubmitting.**

## Notes and lessons learned
