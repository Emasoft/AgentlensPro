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

## SECOND CORRECTION — the first correction over-corrected

The correction above was right that the cause is a ts-row mismatch, and WRONG that the repair left
part of its own backlog behind. Comparing the two stranded sets BY NAME settles it:

| | count |
|---|---|
| old stranded (backup store's pass state) | 1045 |
| new stranded (live store's pass state) | 307 |
| **new ∩ old** | **0** |
| new − old | 307 — every one parked for the FIRST time after the repair |
| old − new | 1045 — every one cleared |

Zero overlap. The repair drained its entire backlog, and TRDD-8TM7I49X's closure line
(`1045 → 0 of the legacy set`) was accurate as written. **The withdrawal of it in this card's first
correction is itself withdrawn** — I inferred "the repair left 307 behind" from two counts without
comparing the names, which is the same shortcut the first correction was written to fix.

## What is actually true (measured 2026-08-26 20:08-21:05)

- **307 files, 144.3 MB, all newly parked**, first seen ~2 minutes after the post-repair server
  restart (`strandedNames=307` at 20:08:39).
- **Flat for ~57 minutes** — 307 at 20:08, 307 at 21:05, 307 twice more 70 s apart. A burst at
  startup, not a steady leak.
- Attributed by the server itself as `ts-row mismatch, never reclaimed`.
- Context: the server had been DOWN for ~12 hours (the first repair attempt held the brake), so the
  first pass after restart met a large backlog of files captured while nothing was ingesting.

## `unparked 0 name(s) (0 still stranded)` — explained, and the line is misleading

Not an inconsistency, but not what it appears to say either. `stagedRewrite` swaps the whole store
DIRECTORY, and `.pass-state.json` lives inside it — so the stranded set went to the backup dir with
the old store. `rustUnpark` then ran against the NEW store, whose state file is empty: it removed 0
because there was nothing left to remove, and reported 0 remaining for the same reason
(`src/cli/storeAdmin.ts:165-173`).

So the unpark step is a **no-op after a swap**, and its output is indistinguishable from "there was
nothing parked". An operator reading `unparked 0` reasonably concludes the repair failed to unpark
anything, when in fact the swap had already discarded the set. That wording is worth fixing on its
own.

## What this card must establish

1. **Why a pass over a post-downtime backlog parks ~307 of ~4,000 files.** Same pass, same store,
   most files fine — the discriminator between parked and not is the finding.
2. **Whether these 307 can drain without an operator running the repair verb**, given they are
   newly created rather than legacy. If not, the shape TRDD-8TM7I49X documented survives its own
   fix and will refill after every extended downtime.
3. **Whether `unparked N` should report the swap case differently** — see above.

## Not the fix

Enlarging `/Volumes/AgentLensSpool` — that was this card's original premise and it is withdrawn.
Sizing is the USER's call regardless, and no agent should reclaim space to paper over a defect
(`~/.claude/rules/never_free_space.md`).

## Acceptance

- [x] The 307 are characterised against the drained 1045 by NAME, not by count: zero overlap, all
      newly parked, flat for ~57 minutes. TRDD-8TM7I49X drained its backlog completely.
- [ ] The discriminator is named — why a post-downtime pass parks ~307 of ~4,000 files and leaves
      the rest — with evidence at a `file:line`, not inferred from the symptom.
- [ ] Established whether newly parked files can drain without an operator running the repair verb.
      If they cannot, the parked set refills after every extended downtime and TRDD-8TM7I49X fixed
      an instance rather than the mechanism.
- [ ] `unparked N name(s) (M still stranded)` distinguishes "unparked nothing because the swap
      already discarded the set" from "nothing was parked" — today both print `0`
      (`src/cli/storeAdmin.ts:165-173`).
- [ ] A test that produces a ts-row mismatch, runs the repair, and asserts the parked set reaches 0
      — the gap this card exists because nothing covered.

## Related

- [[TRDD-8TM7I49X]] — the 1045-name instance, drained 2026-08-26. Its closure line
  `strandedNames 1045 → 0 of the legacy set` is **CONFIRMED correct** by the name-level comparison
  above (zero overlap between the two sets). Nothing about that card's closure needs revisiting;
  this card is about the 307 that appeared afterwards, which are a different population.
- [[TRDD-Z8WJZV8E]] — the sink-status card, whose own premise also needed correcting.
