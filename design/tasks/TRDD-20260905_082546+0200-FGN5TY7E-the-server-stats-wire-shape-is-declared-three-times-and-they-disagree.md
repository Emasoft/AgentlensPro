---
trdd-id: FGN5TY7E
title: The server-stats wire shape is hand-declared three times in two files and the declarations disagree
column: todo
created: 2026-09-05T08:25:46+0200
updated: 2026-09-05T08:25:46+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
created-by: U0L78B3Z
related: [U0L78B3Z, ZIWEB0UW, 8ADTIGKT]
---

# The server-stats wire shape is hand-declared three times in two files and the declarations disagree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T08:25:46+0200

Found while verifying TRDD-U0L78B3Z. Nothing fixed; this card is the finding.

`/api/server-stats` is produced by ONE literal `json!` block in `server_stats.rs` and consumed
through **three separate hand-written TypeScript declarations**, no two of which agree:

| declaration | declares | omits |
|---|---|---|
| `interface ServerStats.bodies` — `serverControl.ts:575-588` | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt, captureDownSince, sinkProblem, live | **parked, spool** |
| `bodiesCaptureLine`'s parameter — `serverControl.ts:509-514` | live, parked, captureDownSince, sinkProblem | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt |
| `burnGuard.ts:110` | captureDownSince | everything else |

Nothing reconciles them with each other or with the emitter. The CLI demonstrably reads
`s.bodies.parked`, which its own main interface does not declare.

**Why this is its own card and not part of U0L78B3Z.** U0L78B3Z is "the Rust writer was never
ported for four fields" — a porting job. This is "one wire object has three partial hand-maintained
shapes and nothing checks them against the producer" — a structural one. Fixing all four fields
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

- [ ] ONE declaration of the server-stats shape, or a generated/shared type, consumed by every
      reader (`serverControl.ts` ×2, `burnGuard.ts`, and any found by the search below).
- [ ] A search establishes the FULL declaration set first — `grep -rn` for the field names across
      `src/`, `media/src/`, `standalone/` — because this card's own count went 2 → 3 when the
      search widened past one file. Record the number found.
- [ ] Something FAILS when producer and consumer diverge: a test that asserts the declared shape
      against a real `/api/server-stats` response, so a field declared-but-never-sent is caught by
      CI rather than by a human noticing a row that never renders. Mutation-verified — delete a
      field from the emitter and confirm it goes red.
- [ ] The four fields from TRDD-U0L78B3Z either send or stop being declared; no declaration
      survives that describes a field nothing emits.

## Notes and lessons learned
