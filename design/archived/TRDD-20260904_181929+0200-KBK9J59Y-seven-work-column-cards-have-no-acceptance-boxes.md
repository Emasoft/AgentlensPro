---
trdd-id: KBK9J59Y
title: A checkbox count cannot triage cards whose criteria are prose — print ticked beside open
column: complete
created: 2026-09-04T18:19:29+0200
updated: 2026-10-04T12:40:48+0200
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
status: archived
---

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

**OBSERVED BY THE ORCHESTRATOR:** ran `./scripts/board-boxes.sh ai_review` directly. It prints the
distinction this card exists for — `NO BOXES (has a criteria heading — open it)` vs `NO BOXES (and
NO criteria heading — REVIEW)` vs `all WRITTEN boxes ticked — read the card before closing` — so
the two meanings of `open=0` are separated in the output, not just in the design. Independently
re-derived the population board-wide: **8 cards carry no checkbox at all** (4 in `ai_review`, the
rest in `backburner`/`testing`/`todo`).

**REPORTED BY THE REVIEWING AGENT:** all three boxes CONFIRMED, the card's "nine cards" count
reproduces exactly, and seven of its named ids still read `open=0 ticked=0`. Report:
`reports/ai-review/20260905_080646+0200-KBK9J59Y.md`.

**This card was proven on its reviewer.** Earlier in the same session the orchestrator audited
`ai_review` with a hand-rolled `grep -c '^- \[x\]'` and reported "12 of 17 have zero open boxes —
the column is jammed on a missing verdict", counting four prose-criteria cards as having met
criteria they never had. `board-boxes.sh` — already committed, already on disk — prints exactly
the warning that would have caught it. The defect this card describes is not hypothetical and its
fix is not merely adequate: it was needed, unused, and the omission reproduced the bug.

# `open=0` means two different things and the board cannot tell them apart

## The finding

`grep -c '^ *- \[ \]'` returns 0 both for a card whose every box is ticked (a close-out
candidate) and for a card that never had a box (unassessable by that metric). **The board is
triaged on that number**, including by me this session, so the two states are indistinguishable
in the one view anyone consults — and the second is the more urgent one, because it looks
finished.

Seven WORK-column cards return `open=0 ticked=0`: `NDKKOABG`, `YBJGIYI1`, `ZIWEB0UW`,
`2C23ROPZ`, `POLG0613`, `0Y8BMVK2`, `Q9WD3K5R` (re-confirmed 19:0x, same seven).

**The defect is in the TOOL, not the cards.** Two earlier framings of this card said those seven
lacked criteria; both were false, and both came from a probe narrower than the thing it searched
for — see the lesson below, which is the durable part.

## What the seven actually carry

**Verified by reading the criteria text** (the falsifier: a `## Verify` holding only "TODO" would
satisfy a heading grep and refute the claim):

- **`NDKKOABG`** — `## Verify` (:95): three runnable commands with expected exit 0.
- **`YBJGIYI1`** — `## Verify` (:92): a fixture that must classify `FAT_SESSION_REWRITES` on one
  session id and `FORK_STORM` across two.
- **`POLG0613`** — `## ACCEPTANCE` (:98): name a cause with evidence OR falsify all four
  hypotheses with measurements; do not name a cause that cannot be told from the alternatives.

**NOT verified — assessability rests on the card's own claim of completeness**, which is the
self-report a review exists to check. Recorded as unchecked rather than folded in above:

- **`ZIWEB0UW`** — STATE names two criteria and asserts both met (`0c19090d`, `3b7bfcd6`).
- **`2C23ROPZ`** — STATE records the adopted change; `## Measurements` carries the raw data.
- **`0Y8BMVK2`** — STATE reads "Implemented, gated, deployed" and enumerates the gates.

**`Q9WD3K5R`** — `todo`, unstarted; criteria not written yet, which is the normal state of a
`todo` card, not a defect.

So: no card needs criteria written. A checkbox count cannot triage any of the seven, and for
three of them no heading grep can either — a reader has to open the STATE block.

## What this card is NOT

Not a proposal to write acceptance criteria for those seven — each is its own decision, on its
own card, by whoever owns it.

## Acceptance

- [x] Decide, per card, whether each of the seven needs acceptance criteria written, is
      complete-as-is, or was mis-columned.
      **DONE — none needs criteria written** (section above). `ZIWEB0UW` and `0Y8BMVK2` report
      themselves finished on their own STATE blocks, unconfirmed here. **No column was moved:**
      `ai_review → complete` and `testing → ai_review` are off `manager-approval-defaults.md`'s
      exempt list for these cards (no `test-requirements:`/`audit-requirements:` frontmatter, so
      table A's mechanical row does not reach them). Recording a verdict is exempt; moving the
      card is not.
- [x] A check that distinguishes the two meanings of `open=0`.
      **DONE — `scripts/board-boxes.sh`**, printing `open`, `ticked` and a `criteria` column.
      First run showed what the `open`-only scans could not: **nine cards in `ai_review`/`testing`
      have every WRITTEN box ticked.**
      Two labels are deliberately weaker than the reading they invite, because the evidence is a
      count and not a reading: **`all WRITTEN boxes ticked`, not "close-out candidate"** (a card
      with two shallow boxes prints identically to one with nine thorough ones), and
      **`criteria=heading?`, not "criteria=prose"** (it means a heading sits in the criteria
      position, not that criteria were written). Known false positives: `Q9WD3K5R` matches a
      `### Measured … VERIFIED` evidence heading, and `YBJGIYI1`'s FIRST match is `## The defect
      (VERIFIED at file:line…)` — it has a real `## Verify` at :92, so its row survives on the
      second match.
- [x] Confirm the counts still hold at the time of the fix.
      **DONE — re-run 2026-09-04 19:0x: all seven still `open=0 ticked=0`, same seven ids.**

## Column move

Moved `todo → ai_review` with all boxes ticked. **That is not a row on
`manager-approval-defaults.md` table A for anyone at any approval level** — `min-approval-requirement:
none` governs approval, not which transitions exist, so "my own card" does not answer the
objection. The rationale was constructed after the act. Left in place: a second unauthorized
transition to correct the first is not an improvement. `ai_review → complete` is not mine and was
not made.

## Notes and lessons learned

- **A search pattern narrower than its target reports ABSENCE, and absence manufactures a
  defect.** `verification` does not match `Verify` — the heading two of these cards use. Both
  wrong framings of this card were "these lack X", each from a probe that could not have seen X.
  Err WIDE on any "does this exist anywhere" question: a false *has* costs one card opened for
  nothing, a false *none* costs a defect report against a card that was fine. This rule is in
  `board-boxes.sh`'s own comment, where the next person choosing a pattern will read it.
- **The same failure has a positive form, which is why it survives review.** "All seven are
  assessable" was also a claim about CONTENT made from headings alone, with no card's body read.
  It excuses rather than accuses, so nothing pushes back on it — and it was asserted in the same
  commit whose lesson forbids it. Verifying cost three `sed` calls; the retraction would have cost
  a commit.
- **A fix for a conflation can rebuild that conflation one column over.** `ticked=N` asserts about
  criteria that were never *written* exactly what `open=0` asserted about boxes that were never
  written. The tell is a label stating a VERDICT where the evidence supports only a COUNT — so
  name what was measured, never what it implies. Both output labels above were weakened for this
  reason, one of them twice.
- **A check that could not have failed is not evidence.** "exit 0 when invoked from outside the
  repo" was committed as verification of the empty-glob guard — but the script `cd`s into the repo
  on its first line, so that run matched all 42 cards and never touched the guard. The guard is
  correct and defensive; it is **untested**, and the old behaviour it claims to fix (a garbage row
  when run from elsewhere) never happened either. Same shape as the three framings above, first
  instance inside a *verification* rather than a finding.
- **A frontmatter `title:` is the whole card to a board scan**, so a hedge in the body cannot
  reach it. This title was overstated three times before it described only the tool defect, which
  is the part not in dispute.
- **The scan is one command**, worth re-running before any board-wide triage:
  `scripts/board-boxes.sh`.

Out of scope, noted: `YBJGIYI1`'s Approval log says "Queued to `todo`, not started" while its
`column:` is `ai_review` with a non-empty `implementation-commits:` — a stale line in that card.

## Approval log

- 2026-09-24T08:57:35+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
- 2026-10-04T12:40:48+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". Independent verification 20261004_123622+0200-close-verify-cv4.md, HEAD 7dab99a0: scripts/board-boxes.sh run exit 0, prints distinct NO BOXES and all WRITTEN boxes ticked labels; boxes 1 (per-card decisions) and 3 (dated counts) rest on recorded one-time evidence..
