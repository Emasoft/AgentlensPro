---
trdd-id: KBK9J59Y
title: Six WORK-column cards have no acceptance criteria and a seventh has prose ones that box-count triage cannot see
column: todo
created: 2026-09-04T18:19:29+0200
updated: 2026-09-04T18:19:29+0200
current-owner: main-session
task-type: audit
project-id: agentlenspro
scope: project
min-approval-requirement: none
priority: medium
severity: MEDIUM
labels: [board, triage, process]
npt: []
eht: []
blocked-by: []
related: [9SYRK6SW, CS2W7E77, HSPUF5XH]
---

# `open=0` means two different things and the board cannot tell them apart

## The finding, measured 2026-09-04

Scanning every card in a WORK column (`dev`/`testing`/`ai_review`/`todo`) for acceptance boxes:

```
NDKKOABG  ai_review  updated=2026-09-01  rust-core-had-no-ci-at-all
YBJGIYI1  ai_review  updated=2026-09-02  fork-storm-cannot-be-told-from-a-fat-session
ZIWEB0UW  ai_review  updated=2026-09-01  alcore-server-stats-lacks-the-capture-block
2C23ROPZ  ai_review  updated=2026-09-02  rust-core-debug-builds-dominate-host-disk-writes
POLG0613  testing    updated=2026-09-03  one-unexplained-early-break-cold-write-after-a-heartbeat-fire
0Y8BMVK2  testing    updated=2026-09-03  dashboard-reported-catalogs-as-per-turn-cache-writes-…
Q9WD3K5R  todo       updated=2026-09-04  one-storage-gateway-not-thirty-four-migrated-call-sites
```

**Seven cards have ZERO acceptance boxes — neither `- [ ]` nor `- [x]`.** `grep -c '^ *- \[ \]'`
returns 0 for each, which is the same value it returns for a card whose every box is ticked.

**THE TWO CASES, and they need DIFFERENT remedies — read this before the framing below.**
- **Six cards have no acceptance-shaped section at all** (`NDKKOABG`, `YBJGIYI1`, `ZIWEB0UW`,
  `2C23ROPZ`, `0Y8BMVK2`, `Q9WD3K5R`) → criteria may genuinely be MISSING. A real gap.
- **`POLG0613` has `## ACCEPTANCE` with criteria in PROSE** → nothing is missing; it is perfectly
  assessable, and the only problem is that a checkbox scan cannot COUNT it. That is an argument for
  a CONVENTION (write criteria as checkboxes so they are machine-countable), not a defect report.

Conflating those two is what the original framing did, and it would misroute whoever picks this up.

**CORRECTED 18:2x — "no criterion was ever written" was FALSE for one of them, and I asserted it
without opening any.** A checkbox grep sees checkbox syntax; it says nothing about prose criteria.
Checked afterwards for acceptance-shaped headings (`acceptance|verification|definition of done|
criteria`, case-insensitive):

- **`POLG0613` HAS `## ACCEPTANCE`** — criteria in prose, no checkboxes. It is assessable, and the
  scan called it uncriteria'd.
- The other **six** have no such heading at all: `NDKKOABG`, `YBJGIYI1`, `ZIWEB0UW`, `2C23ROPZ`,
  `0Y8BMVK2`, `Q9WD3K5R`.

So the supportable claim is the narrow one, and it still justifies this card: **seven cards have no
checkboxes, so a checkbox count cannot triage them; six of those also have no acceptance-shaped
section.** Even that is a heading grep — prose criteria under some other heading would evade it.
The scope-inherits-the-search failure, committed in the card documenting a triage blind spot.

## Why this is worth a card and not just a note

**A box-count scan is how this board actually gets triaged, including by me this session.** I ran
two such scans to choose which cards to work, and both listed these seven as `open=0` — the same
column that meant "all criteria met" for `6SPXOV0P` and `9SYRK6SW`. The metric silently conflates:

- *every criterion is satisfied* — the card is a close-out candidate, and
- *no criterion was ever written* — the card cannot be assessed at all.

The second is arguably the more urgent state, and it is the one that looks finished.

`9SYRK6SW` is the near-miss that surfaced this. It sits in `testing` at `open=0`, and I nearly
reported it as having no acceptance section at all — my `sed` pattern was `^## Acceptance` and its
heading is `## ACCEPTANCE`. It has six ticked boxes. The board-wide scan is what caught my error,
and the same scan is what exposed the seven that genuinely have none.

## What this card is NOT

Not a proposal to write acceptance criteria for those seven — each is its own decision, on its own
card, by whoever owns it. Filing seven derived cards from one scan would be worse than the problem.

## Acceptance

- [ ] Decide, per card, whether each of the seven needs acceptance criteria written, is
      complete-as-is and should be moved to a terminal column, or was mis-columned. Seven small
      decisions, not one sweeping rule.
- [ ] A check that distinguishes the two meanings of `open=0`. Cheapest form: report `open` and
      `ticked` together (`open=0 ticked=0` vs `open=0 ticked=6`) wherever a box count is used for
      triage — the distinction costs one extra `grep -c` and is what the scans this session already
      printed once the second column was added.
- [ ] Confirm the counts still hold at the time of the fix; FOUR of these were last updated
      2026-09-01/02 (`NDKKOABG` 09-01, `ZIWEB0UW` 09-01, `YBJGIYI1` 09-02, `2C23ROPZ` 09-02) and
      the set will drift. An earlier version said "three" — miscounted from the same listing that
      shows four.

## Notes and lessons learned

- **Filed because the finding was otherwise buried.** It lived only in the body of commit
  `b69cb30d` and in a gitignored `docs_dev/` handoff. That is the disown-without-rehome shape
  TRDD-CS2W7E77 was itself filed to repair — a real finding recorded somewhere nobody looks is
  indistinguishable from one never made. Writing it into a commit felt like recording it; it is
  not, because nobody greps commit bodies to triage a board.
- **The scan is one command** and is worth re-running before any board-wide triage:
  `for f in design/tasks/*.md; do ... grep -c '^ *- \[ \]' / '^ *- \[x\]' ...; done` — printing
  BOTH counts is the whole point.
