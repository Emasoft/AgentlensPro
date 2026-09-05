---
trdd-id: FGN5TY7E
title: The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree
column: todo
created: 2026-09-05T08:25:46+0200
updated: 2026-09-05T08:29:12+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
created-by: U0L78B3Z
related: [U0L78B3Z, ZIWEB0UW, 8ADTIGKT]
---

# The server-stats bodies shape is hand-declared twice in one file and the two declarations disagree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T08:25:46+0200

Found while verifying TRDD-U0L78B3Z. Nothing fixed; this card is the finding.

`/api/server-stats`'s `bodies` object is produced by ONE literal `json!` block in
`server_stats.rs` and consumed through **two separate hand-written TypeScript declarations in one
file**, which disagree:

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
