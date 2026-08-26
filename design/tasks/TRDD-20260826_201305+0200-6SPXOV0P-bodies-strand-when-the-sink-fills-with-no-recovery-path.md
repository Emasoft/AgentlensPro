---
trdd-id: 6SPXOV0P
title: 307 files remain parked with a ts-row mismatch after the TRDD-8TM7I49X repair
column: todo
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T21:05:00+0200
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [bodies, ingest, silent-failure, capacity]
relevant-rules: []
---

## CORRECTION — this card's first version blamed the wrong cause

**Authored 2026-08-26 20:13 claiming these 307 were ENOSPC residue from the spool volume filling.
That was a GUESS from coincidence — the volume had hit ENOSPC in the same window — and it was
wrong.** The server attributes them itself, and it says something else:

```
capture: 597 live file(s), newest 0s ago | PARKED 307 file(s) 144.3MB — ts-row mismatch,
never reclaimed (TRDD-8TM7I49X)
```

`ts-row mismatch` is the SAME cause as the 1045 that card was about — not a sink failure. The
correction matters because the two lead opposite ways: an ENOSPC story ends in "size the volume
and add backpressure", and none of that would have touched this.

## What is actually true (measured 2026-08-26 20:08-21:05)

| fact | evidence |
|---|---|
| 307 parked, 144.3 MB | `server status`, twice 70 s apart — **stable, not growing** |
| present ~2 min after the repair's server restart | pass state `strandedNames=307` at 20:08:39 |
| the repair reduced but did not clear the set | `strandedNames` 1045 → 307, and the repair's own line read `unparked 0 name(s)` |
| same cause as the drained set | the server's own `ts-row mismatch` attribution |

So the TRDD-8TM7I49X repair corrected **1045 ts rows in the store** and left **307 files that
still fail the ts check**. The backlog shrank by 738; it did not go to zero.

## What this card must establish

1. **Why these 307 differ from the 738 the repair resolved.** Same verb, same run, two outcomes —
   that difference is the whole finding, and it is checkable against the files themselves.
2. **Whether `repaired 1045 ts row(s); unparked 0 name(s)` is consistent.** The repair reports
   repairing rows and unparking nothing; the set nonetheless fell 1045 → 307 on restart. One of
   those two numbers is measuring something other than what its wording implies.
3. **Whether the set can still only shrink by hand.** If the answer is yes, the shape TRDD-8TM7I49X
   documented is intact and only its backlog was drained.

## Not the fix

Enlarging `/Volumes/AgentLensSpool` — that was this card's original premise and it is withdrawn.
Sizing is the USER's call regardless, and no agent should reclaim space to paper over a defect
(`~/.claude/rules/never_free_space.md`).

## Acceptance

- [ ] The difference between the 738 the repair resolved and the 307 it did not is named with
      evidence from the files themselves, not inferred from the counts.
- [ ] `repaired N ts row(s); unparked M name(s)` is shown to mean what it says, or its wording is
      corrected — `unparked 0` alongside a set that fell by 738 cannot both be right as read.
- [ ] The 307 either drain or the reason they must stay is recorded IN THE CODE at a `file:line`.
- [ ] A test that produces a ts-row mismatch, runs the repair, and asserts the parked set reaches 0
      — the gap this card exists because nothing covered.

## Related

- [[TRDD-8TM7I49X]] — the 1045-name instance, drained 2026-08-26. **Its closure counted
  `strandedNames 1045 → 0 of the legacy set`, which read the residual 307 as unrelated. That
  reading came from this card's original ENOSPC guess and is withdrawn here.** The card stays
  complete — its 1045 did drain and its acceptance was met — but the "0 of the legacy set" phrasing
  claims more than was measured, and this card is the honest continuation.
- [[TRDD-Z8WJZV8E]] — the sink-status card, whose own premise also needed correcting.
