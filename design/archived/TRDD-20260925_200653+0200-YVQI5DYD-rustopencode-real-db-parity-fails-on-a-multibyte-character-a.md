---
trdd-id: YVQI5DYD
title: rustOpenCode real-db parity fails on a multibyte character at the truncation boundary
column: complete
status: archived
created: 2026-09-25T20:06:53+0200
updated: 2026-10-04T13:54:52+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T20:06:53+0200
implementation-commits: [fb8392fe]
---

# rustOpenCode real-db parity fails on a multibyte character at the truncation boundary

## Approval log

- 2026-09-25T20:06:53+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
STATE 2026-09-25T20:08:20+0200: Carded from the 2026-09-25 full-suite verification (2814 passing / 1 failing). Symptom: 'rustOpenCode — P3d cross-engine parity > the REAL opencode db parses identically (native WAL vs _mergeWal)' fails on THIS machine's real opencode db. The diff is one character at a truncation boundary: the expected value carries U+FFFD (string cut mid-codepoint) where actual is clean. Machine-data-dependent: a new opencode session created 2026-09-25 (deepseek-v4.1-flash, chatcmpl-5b18cd76) carries a multibyte char at the exact byte offset where one engine truncates. Class: X4YTS5BF (real-machine-data tests), sibling of TRDD-B7DSTJLS. Next: find which engine truncates by BYTES instead of CHARACTERS (JS Buffer vs Rust String boundary in opencode resultSummary extraction), fix the byte-to-char boundary, re-run on the live db.
- 2026-09-25T20:41:22+0200 — column → todo by main-agent@agentlenspro. adversarial review of c7c540c8: a real parser defect (byte-vs-char truncation) is product code, not a backburner chore — its next-action is already written on the card
- 2026-10-04T13:54:52+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". fb8392fe; checks run by the main agent: check-types, lint, compile-tests exit 0; whole unit suite 2951 passing, 12 pending, 1 failing (the hook-spool revive test, failing before this work because the installed CLI bundle is stale, TRDD-E9RM51XG); the real-db parity test passes again.

## Notes

- 2026-10-04T13:02:12+0200 — worker wB: snip in src/timelineRetention.ts now drops a split surrogate pair like Rust utf16_slice; no gen-*.mjs fixture imports timelineRetention. Test 'snip never cuts inside a surrogate pair' red without fix, green with; the REAL db parity test passes on the same db.
2026-10-04 read-only check of snip callers: all 14 snip call sites and 6 capText sites in src/logReader.ts and timelineRetention.ts only retain the result; none compares a length against the cap to detect truncation. No generator under rust-core tests/fixtures imports timelineRetention directly (gen-sessionreports-expected.mjs reaches logReader; not run, it regenerates fixtures). Mutation check: reverting snip turns the timelineRetention surrogate test red (1 failing), restored.

## Acceptance

- [x] snip drops a split surrogate pair like the Rust port, a test is red without the fix, and the real-db parity test passes again (fb8392fe); checklist written from the card's own notes at close time, 2026-10-04.
