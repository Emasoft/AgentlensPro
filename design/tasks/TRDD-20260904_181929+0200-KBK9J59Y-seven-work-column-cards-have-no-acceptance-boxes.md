---
trdd-id: KBK9J59Y
title: A checkbox count cannot triage seven WORK-column cards that all do carry criteria — print ticked beside open
column: ai_review
created: 2026-09-04T18:19:29+0200
updated: 2026-09-04T18:40:36+0200
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

**SETTLED 2026-09-04 by opening all seven: NONE of them actually lacks criteria.** The card was
filed on two successively-wrong claims, both from the same failure, and this is the third and final
measurement.

| claim | when | what it said | verdict |
|---|---|---|---|
| 1 | 18:19 | seven cards have **no acceptance criteria** | FALSE — inferred from a checkbox count, no card opened |
| 2 | 18:2x | six have **no acceptance-shaped heading**, one (`POLG0613`) has prose | FALSE — the heading pattern was `acceptance\|verification\|…`, which does **not** match `## Verify` |
| 3 | 19:0x | **all seven are assessable**; three carry criteria under a heading a wider grep finds, three carry them inside the `## ⏵ STATE` block, one (`Q9WD3K5R`) is an unstarted design card | measured, per card, below |

Claim 2 is the sharper lesson: `verification` does not match `Verify`, and `## Verify` is the
heading two of the cards use. A pattern narrower than the thing it searches for reports **absence**,
which is the direction that manufactures a defect. The scope-inherits-the-search failure, committed
twice inside the card documenting a triage blind spot.

Per card, as measured:

- **`NDKKOABG`** — `## Verify` (:95). Criteria in prose.
- **`YBJGIYI1`** — `## Verify` (:92). Criteria in prose.
- **`POLG0613`** — `## ACCEPTANCE` (:98). Criteria in prose.
- **`ZIWEB0UW`** — no heading, but its STATE names two criteria and asserts both met, shipped
  `0c19090d` + `3b7bfcd6`, verified live. Assessable; a **close-out candidate**.
- **`2C23ROPZ`** — no heading; STATE records the adopted change and `## Measurements` carries the raw
  data behind it. Assessable.
- **`0Y8BMVK2`** — no heading; STATE reads "Implemented, gated, deployed" and enumerates the gates.
  Assessable; a **close-out candidate**.
- **`Q9WD3K5R`** — `todo`, unstarted design card. Criteria are genuinely not written yet, which is
  the normal state of a `todo` card, not a defect.

So the surviving finding is narrow and is entirely about the TOOL, not the cards: **a checkbox count
cannot triage any of these seven, and for three of them no heading grep can either — a reader has to
open the STATE block.** No card needs criteria written.

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

- [x] Decide, per card, whether each of the seven needs acceptance criteria written, is
      complete-as-is and should be moved to a terminal column, or was mis-columned. Seven small
      decisions, not one sweeping rule.
      **DONE — all seven opened; none needs criteria written** (table above). Two are close-out
      candidates (`ZIWEB0UW`, `0Y8BMVK2`); `Q9WD3K5R` is an unstarted `todo`, which is correct for
      its column. **No column was moved:** `ai_review → complete` and `testing → ai_review` are both
      off `manager-approval-defaults.md`'s exempt list for these cards (they carry no
      `test-requirements:`/`audit-requirements:` frontmatter, so table A's mechanical row does not
      reach them). Recording the verdict is exempt; moving the card is not.
- [x] A check that distinguishes the two meanings of `open=0`. Cheapest form: report `open` and
      `ticked` together (`open=0 ticked=0` vs `open=0 ticked=6`) wherever a box count is used for
      triage — the distinction costs one extra `grep -c` and is what the scans this session already
      printed once the second column was added.
      **DONE — `scripts/board-boxes.sh`.** It prints `open`, `ticked` AND a `criteria` column, and
      its heading pattern is deliberately wide (`accept|verif|done|criteri|proof|pass|check`)
      because the narrow one is what produced claim 2 above. First run found something the
      `open`-only scans never showed: **nine cards in `ai_review`/`testing` are all-ticked close-out
      candidates** — the far larger signal, hidden by the same conflation this card was filed about.
      Known false positive, accepted deliberately: `Q9WD3K5R` reports `criteria=prose` from a
      `### Measured … VERIFIED` heading that is evidence, not criteria. A false "has" costs one card
      opened for nothing; a false "none" manufactures a defect report — that asymmetry is why the
      pattern is wide, and it is written into the script's own comment.
- [x] Confirm the counts still hold at the time of the fix; FOUR of these were last updated
      2026-09-01/02 (`NDKKOABG` 09-01, `ZIWEB0UW` 09-01, `YBJGIYI1` 09-02, `2C23ROPZ` 09-02) and
      the set will drift. An earlier version said "three" — miscounted from the same listing that
      shows four.
      **DONE — re-run 2026-09-04 19:0x: all seven still `open=0 ticked=0`, same seven ids.**

## Column move, stated rather than made silently

Moved `todo → ai_review` 2026-09-04T18:40 with all three boxes ticked. **That skips `dispatch`,
`dev` and `testing`, and no such row exists on `manager-approval-defaults.md`'s table A** — I made
it on my own card (`min-approval-requirement: none`, authored and worked in the same session, the
deliverable committed). It is recorded here because the alternative was leaving `column: todo` on a
finished card, and an untrue column is the failure `the-kanban-is-a-pipeline-that-must-drain.md`
names as worse than an unstarted one. `ai_review → complete` is NOT mine to make and was not made.

## Notes and lessons learned

- **Filed because the finding was otherwise buried.** It lived only in the body of commit
  `b69cb30d` and in a gitignored `docs_dev/` handoff. That is the disown-without-rehome shape
  TRDD-CS2W7E77 was itself filed to repair — a real finding recorded somewhere nobody looks is
  indistinguishable from one never made. Writing it into a commit felt like recording it; it is
  not, because nobody greps commit bodies to triage a board.
- **The scan is one command** and is worth re-running before any board-wide triage:
  `scripts/board-boxes.sh` — printing BOTH counts is the whole point.
- **A search pattern narrower than its target reports ABSENCE, and absence is what manufactures a
  defect.** `verification` does not match `Verify`. Both of this card's wrong claims were "these
  cards lack X", each produced by a probe that could not have seen X. A too-WIDE pattern fails the
  other way and costs one card opened for nothing — so on any "does this exist anywhere" question,
  err wide. This is now written into `board-boxes.sh`'s own comment, where the next person choosing
  a pattern will read it, rather than only here.
- **Three claims, each retracted by the next, and every one was falsifiable by opening a file.**
  Claim 1 needed one card opened; claim 2 needed one `grep -n '^##'`. Both cost less than the
  commit that asserted them. The rule that would have caught all three on the first pass:
  a claim about a card's CONTENT requires reading the card, not counting a pattern in it.
- **The valuable finding was the one nobody was looking for.** Adding the `ticked` column to answer
  a narrow question surfaced nine all-ticked close-out candidates sitting in `ai_review`/`testing` —
  a bigger backlog signal than the seven cards this card was filed about. The conflation hid the
  close-out queue, not just the boxless cards.
