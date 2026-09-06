---
trdd-id: 82ADFE5D
title: rustSummarize end-to-end parity fails on the real corpus because a string exceeds the V8 string cap
column: todo
created: 2026-09-06T02:11:03+0200
updated: 2026-09-06T02:27:51+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [7YPQWKPG, FSMISF5K, B7DSTJLS]
relevant-files: [src/test/rustSummarize.test.ts]
labels: [tests, summary-size, memory]
---

# rustSummarize end-to-end parity fails on the real corpus because a string exceeds the V8 string cap

Found by the whole-suite mocha run launched for TRDD-B7DSTJLS
(`reports_dev/b7dstjls-whole-file-20260905_214506+0200.txt`, 46 min, 2,653 passing / 7 failing /
11 pending): `rustSummarize — end-to-end engine parity` fails with
`Error: Cannot create a string longer than 0x1fffffe8 characters` (V8's ~512 MB string limit).

A >512 MB string is built somewhere in the rustSummarize parity path; which string is unknown
until the throwing frame is read. This error fires on ANY >512 MB string — `JSON.stringify`, a
`readFileSync(path, 'utf8')`, a `Buffer.toString`, a `join` — so it does not by itself point at the
serialized summary. The run happened 21:45–22:31, when the window held 541k–620k spans
(TRDD-YILE6N3T; 677k is the later 02:10 reading, not the run-time figure). Today's log segment
`2026-09-05.ndjson` is 526 MB — just over the cap — so a plain `readFileSync(segment, 'utf8')` on
the TS side of the parity test fits the number as well as the summary does.

This is the same fact as the USER's 2026-09-05 directive from the test side: a whole-window summary
is too large to be a value at all. It is expected to dissolve when FSMISF5K makes summaries
per-session DuckDB queries; until then the test needs a bounded input.

## NEXT ACTION

Capture the stack frame that throws before choosing between (a) serialized summary, (b)
alsummarize stdout join, (c) `readFileSync` of the 526 MB segment — (c) means the fix is streaming
the segment, not shrinking the window. Then re-run `npx mocha out/test/test/rustSummarize.test.js`
alone at low load to confirm the failure is deterministic (not the load-113 run's artefact), then
either bound the parity input (a window cap or a fixture subset) or mark the real-corpus case as
gated on FSMISF5K — decide on the card, not in the test file's comments.

## Acceptance

- [ ] Failure reproduced alone with the exact error, or shown to be load-dependent.
- [ ] `rustSummarize` parity green on CI-sized input; the real-corpus case bounded or explicitly
      gated on FSMISF5K.

## Notes and lessons learned

## Approval log

- 2026-09-06T02:11:03+0200 — Authored into `todo` (Tier 0 test bugfix) from a measured failure.
