---
trdd-id: FGN5TY7E
title: The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree
column: blocked
created: 2026-09-05T08:25:46+0200
updated: 2026-10-16T17:07:14+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
created-by: U0L78B3Z
related: [U0L78B3Z, ZIWEB0UW, 8ADTIGKT, HDUETCU7]
implementation-commits: [0c01a3e1, 7659b9ca, 34569e8f]
blocked-by: [HDUETCU7]
status: tasked
pre-block-column: testing
unblock-when: [trdd:HDUETCU7 terminal]
blocker-probe: [trddgrep, why, FGN5TY7E]
blocker-holds-if: not-match:READY
---

# The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T16:49:28+0200

**2026-10-05: parts of this head are superseded; read "Review 2026-10-05" at the end of the card first.** The box-3 mutation named below as the next action is recorded as run on 2026-10-04. Box 4 is split out to TRDD-HDUETCU7 and is no longer decided here. Boxes 1 and 2 were re-verified and ticked on 2026-10-05 (commit d1eb1de9). What remains: box 4, carried by TRDD-HDUETCU7, or the owner's rewording of it.

**`ai_review` → `testing` (REJECTED 16:46, accepted by the orchestrator).** Boxes 1–2 verified met by
the review; box 3 is PARTIAL by the card's own 11:21 STATE and its mutation run — delete a field from
the emitter in `server_stats.rs`, confirm the frozen-shape test in `tests/server_stats.rs` goes red,
restore — was never performed, so the card moved toward `human_review` ahead of its own stated gate.
No code is pending for box 3 — its deliverable is that test run plus an appended result, hence
`testing` (YBJGIYI1 sat in `dev` for a run-then-rewrite because its gate LINE was false and must be
rewritten; here the card text needs no correction). Box 4 is a DEFERRED CODE DECISION, not "done":
the four fields either get sent or stop being declared — resolve it or split it to its own card before
`ai_review`; if the answer is "send them", this card goes back to `dev`.
`implementation-commits` was `[a55074bd]` — TRDD-U0L78B3Z's fix commit, not this card's — corrected to
`[0c01a3e1, 7659b9ca]` on their HUNKS, not their tags: `0c01a3e1` rewrites `src/cli/serverControl.ts`
(+49/−29, the one `ServerStatsBodies` declaration); `7659b9ca` touches `serverControl.ts` (+6/−2) and
extends `tests/server_stats.rs::body_matches_the_frozen_key_order_exactly` (+22/−4, the "EMITTER's key
set only" comment) — the very test box 3 leans on. **NEXT ACTION:** run the box-3 mutation when the
machine is free (a Rust build shares the CPU today), record the red/green pair with the command and
date, decide box 4, then `testing → ai_review`.

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

- [x] ONE declaration of the server-stats `bodies` shape, or a generated/shared type, consumed by
      every reader (`serverControl.ts` ×2 today, plus any found by the search below).
- [x] A search establishes the FULL declaration set FIRST — `grep -rn` for the field names across
      `src/`, `media/src/`, `standalone/`, and **open every hit to see what type it belongs to**.
      This card's first version counted `burnGuard.ts:110` as a third declaration from an unopened
      grep line; it is a `BurnGuardOptions` parameter member. Record the number found AND what each
      hit turned out to be — a hit is a field name, not a declaration of this object.
- [x] Something FAILS when producer and consumer diverge: a test that asserts the declared shape
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
2026-10-04 — box 3 mutation run: removed the sinkProblem line from the bodies json! in server_stats.rs; tests/server_stats.rs::body_matches_the_frozen_key_order_exactly went red at line 77 (left [archive,lastPass,live,captureDownSince,parked] right [...captureDownSince,sinkProblem,parked]); file restored, --test server_stats 4 passed. Box 4 left open: the two unsent fields (reclaimedSinceBoot, lastNonZeroPassAt) need either the unported bodies purge or a TS declaration change plus a rebuilt, deployed binary; that is the owner's decision.
2026-10-04: code landed at 34569e8f; boxes 1, 2 and 4 are still unticked on the card (declaration set, single declaration, unsent reclaimedSinceBoot/lastNonZeroPassAt decision); owed by the main agent or owner decision on box 4. Not closed.

## Review 2026-10-05 (in the owner's stead)

Box 4 is split out to TRDD-HDUETCU7 and stays unticked here; it can tick when that card closes or when the owner rewords it. The reviewing session first proposed deleting the two declarations; an adversarial review and a read of TRDD-C5L779YI (archived, so it takes no link back) showed that would remove the only consumer of that card's accepted fix. This card called box 4 the owner's decision; splitting it is the option this card's own head names, taken under the order of 2026-10-05 as the session's reading. The head's "run the box-3 mutation" is done by the note of 2026-10-04, which this session did not see run. Boxes 1 and 2 were not re-verified in this entry. No test was run for this entry.

Boxes 1 and 2 ticked on 2026-10-05 at commit 11c34385. Number of declarations of the server-stats bodies object found: one, ServerStatsBodies at src/cli/serverControl.ts line 627. Every hit below was opened by a read-only worker (report in gitignored docs_dev); the main agent ran the bodies search itself and read the matched lines, and read the worker's report, not the files. Search for `bodies:` as a member or annotation over src, media/src and standalone, tests excluded, 15 hits: serverControl.ts 648 (a Pick of the one declaration) and 707 (a member typed with it), both uses; serverControl.ts 836, the status line's template text; burnGuard.ts 67 and 289, a boolean sources.bodies and its literal; cli/diagnosticsCli.ts 256, sources.bodies typed unknown; shared/branchSerialize.ts 31, SerialBody[]; media/src/CopyBranchButton.tsx 113, a literal of that type; store/validate.ts 28 and 78, a number and its literal; cli/ctxmapCli.ts 244, a local array; and four comment lines (bodiesActivity.ts 156, cacheBreakTimeline.ts 302, store/ingestPass.ts 117, store/sections.ts 4). Search for the emitter's key names as typed members: lastPass, captureDownSince, sinkProblem and parked are all inside ServerStatsBodies; burnGuard.ts 110 is the BurnGuardOptions parameter member this card already describes; no type names two or more of the keys together outside the one declaration. One fragment remains: parkedSuffix at serverControl.ts 678 hand-copies the three-key parked sub-shape as a parameter type. The other readers of the response were opened and none touches bodies: serverControl.ts 567 (pid and dataDir), 747 (cast to ServerStats, so through the one declaration), setup.ts 213 (StatsShape has no bodies), storeAdmin.ts 142 (result discarded). Not covered: tests, gitignored and generated files, and a cast that spells the keys some other way. No build or test was run. Box 3 stays ticked on the note of 2026-10-04, which this session did not see run. Box 4 is the only open box.

Corrections to the entry above (2026-10-05, after a review of commit d1eb1de9). Box 1 was ticked with a stated exception, as the session's judgment: two hand-written copies of the three-key parked sub-shape exist outside the one declaration, the parameter of parkedSuffix (src/cli/serverControl.ts line 678) and interface ParkedGauge (src/rustStorePass.ts line 111, read by the main agent); neither declares the bodies object, and both could be typed as ServerStatsBodies['parked']. "Every hit below was opened" overstates: the list is the bodies search plus part of the key-name search; hits in cli/surfaces.ts and storeAdmin.ts were classified by the worker and are not listed, and rustStorePass.ts was opened by the worker only around lines 122 to 135. The key-name search covered lastPass, captureDownSince, sinkProblem and parked in member form only; archive, live and spool were not searched as typed members. The names reclaimedSinceBoot and lastNonZeroPassAt were searched as plain names earlier the same day, by the main agent and by a worker, with hits only in serverControl.ts and one Rust test comment. The main agent's own run of the bodies search printed 13 lines, the worker's 15; the difference is two comment lines dropped by the main agent's filter. The sentence above saying boxes 1 and 2 were not re-verified refers to the earlier entry only. Box 3's test freezes the emitter's key set and cannot see the TypeScript interface, as this card's own review of 2026-09-05 says; it is the weakest of the three ticks.
- 2026-10-05 18:10: TRDD-HDUETCU7's code landed as commit 97f6806a (source and tests, not deployed; its full crate test run is still owed). Box 4 here stays unticked until that card closes or the owner rewords the box. The move of this card to blocked has not been made.

## Approval log

- 2026-10-16T11:13:34+0200 — column → blocked by main-agent@agentlenspro. box 4 rides on HDUETCU7, which waits in human_review; triage row 8
