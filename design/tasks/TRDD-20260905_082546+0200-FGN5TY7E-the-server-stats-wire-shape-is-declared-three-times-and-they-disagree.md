---
trdd-id: FGN5TY7E
title: The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree
column: ai_review
created: 2026-09-05T08:25:46+0200
updated: 2026-09-05T11:43:19+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
created-by: U0L78B3Z
related: [U0L78B3Z, ZIWEB0UW, 8ADTIGKT]
implementation-commits: [a55074bd]
---

# The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T11:21:29+0200

**DONE in the working tree (uncommitted, same gate as TRDD-U0L78B3Z: `reports_dev/diz-final.txt`).**
`src/cli/serverControl.ts` now has ONE `export interface ServerStatsBodies`; `ServerStats.bodies`
uses it and `bodiesCaptureLine` takes a `Pick<>` of it (a projection, not a second declaration).
The unread `spool?` was dropped rather than half-typed. Box by box:
- Box 1 met. Box 2 met: the tree-wide shape grep (`bodies\s*\??:\s*\{` over `src`, `media/src`,
  `standalone`, tests excluded) found exactly the two declarations, both in `serverControl.ts`;
  `burnGuard.ts:110` is a `BurnGuardOptions` parameter member; `media/src` has zero.
- Box 3 met by the frozen-shape test `tests/server_stats.rs` (`keys(&body["bodies"])` is now the
  FULL set the interface declares). The "delete a field and confirm red" mutation was argued
  from the assertion's shape, not RUN — do it once before `human_review`.
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

## Notes and lessons learned
