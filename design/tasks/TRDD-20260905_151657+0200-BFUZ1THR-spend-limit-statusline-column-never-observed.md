---
trdd-id: BFUZ1THR
title: The rate_limits spend_limit statusline column has never been observed in a captured row
column: backburner
created: 2026-09-05T15:16:57+0200
updated: 2026-09-05T15:16:57+0200
current-owner: main-session
task-type: spike
priority: low
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [YE15B2JK, SIGBCMGL]
review-after: 2026-10-05
---

# The `rate_limits.spend_limit` statusline column has never been observed in a captured row

Split out of TRDD-YE15B2JK on 2026-09-05. That card's fifth acceptance box — "`rate_limits.spend_limit`
column populated from a real gateway-captured row (not yet observed)" — was appended in `e4b8ae88`,
the same commit that ticked its four original boxes and moved it to `ai_review`; it was never part of
the card's scope, and it cannot be met by any work on this repo: it waits on the harness emitting the
field. Leaving it open would have held a finished card out of `human_review` indefinitely, so it lives
here as its own parked spike.

## What is known (2026-09-05)

- Today's live statusline rows (`~/.agentlens/statusline/main/2026-09-05/wal-*.ndjson`) contain zero
  occurrences of `spend_limit`; only the four `rate_limits_{five_hour,seven_day}_*` fields appear
  (grep by the orchestrator, and the 15:15 AI-review of YE15B2JK read the same row).
- The store deliberately does NOT declare the column: `src/statuslineStore.ts:230-233` (comment at
  the end of `GUARANTEED_COLUMNS`) says `rate_limits.spend_limit` (CC 2.1.251) "only appears behind a
  Claude apps gateway with spend limits, no sample of its flattened shape has been captured on this
  machine, and a guessed column name is worse than none". So the first observed row is the whole task.

## Acceptance

- [ ] A captured statusline row containing `rate_limits.spend_limit` is observed (quote the row's date
      and file), OR a dated note records that the field still has not appeared and the card is re-parked.
- [ ] If observed: the column is populated by the writer and read back by a test against that real row.

## Notes and lessons learned
