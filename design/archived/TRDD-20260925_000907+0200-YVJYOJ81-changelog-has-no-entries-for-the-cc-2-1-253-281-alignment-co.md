---
trdd-id: YVJYOJ81
title: CHANGELOG lacks entries for the alignment commits after ef1577b6
column: complete
status: archived
created: 2026-09-25T00:09:07+0200
updated: 2026-10-04T13:54:57+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:07+0200
implementation-commits: [00e12331]
---

# CHANGELOG has no entries for the CC 2.1.253-281 alignment commits

Find the last commit that touched CHANGELOG.md (`git -C <repo> log -1 --format='%h %ad' -- CHANGELOG.md`) and list every later commit whose subject or body mentions TRDD-ZQQYRYBO, TRDD-ORGJ0E3G or TRDD-Z53IJFE9 (hash plus subject).

Known user-visible contract changes to name: meta.attachmentKind can no longer be "instructionsRule" (e02bb80a), and I6c2 (landed in 3d128e0d) adds a `ttlGapSource` field and an IDLE_TTL_PARTIAL_EXPIRY cause.

## Approval log

- 2026-09-25T00:09:07+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-25T00:22:50+0200 — column → todo by main-agent@agentlenspro.
- 2026-10-04T13:54:57+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". 00e12331; docs-only CHANGELOG entries, no code check applies.

## STATE

Next action: run the git log query above, draft the CHANGELOG.md entries covering the alignment commits, and land them in one commit with the standard TRDD subject tag. — 2026-09-25
Correction: 7f0b3d4e, 8eb2af75 and ef1577b6 DID add CHANGELOG entries for this stream; the debt starts after ef1577b6.
2026-10-04 wF: CHANGELOG [Unreleased] gained entries for hook-context-cost, ttlGapSource/IDLE_TTL_PARTIAL_EXPIRY/cacheCreateTokens1h, instructions+prompt_snapshot attachments and request_body_id pairing (Added); version-graded cache-risk causes, one compaction predicate with attachmentKind no longer instructionsRule, dispatch counting, usage-only 1h backfill (Fixed). Docs card, no test.

## Git result

Last CHANGELOG.md commit: ef1577b6 2026-09-24.
Later commits mentioning TRDD-ZQQYRYBO, TRDD-ORGJ0E3G or TRDD-Z53IJFE9 (none for Z53IJFE9):
e02bb80a feat(context): one compaction predicate; dedup by content since the last boundary (TRDD-ZQQYRYBO I9b)
a2b73fa6 feat(cache-risk): grade an effort change on Fable 5.1 at CC 2.1.260+ as ambiguous (TRDD-ZQQYRYBO I6)
61283c1b fix(ingest): save only the patched cards per backfill chunk; drain waiting changes first (TRDD-ORGJ0E3G)
ada59e75 docs(memory): mark what the three build-trap lessons measured vs inferred (TRDD-ZQQYRYBO)
88fde0c6 docs: correct overstated evidence on three cards; card the hook-revive boot storm (TRDD-WKLD508O, TRDD-ORGJ0E3G, TRDD-ZQQYRYBO, TRDD-JJLI6GEH)
a9887754 docs(memory): three build traps met while landing the CC alignment patches (TRDD-ZQQYRYBO)
eb67dce1 docs: record today's evidence on the alignment, 1h-tier and RSS-cap cards (TRDD-ZQQYRYBO, TRDD-ORGJ0E3G, TRDD-WKLD508O)
bb53a24c feat(cache-risk): grade slash-command causes by the Claude Code version that ran them (TRDD-ZQQYRYBO I6)
63f41d04 fix(ingest): run the 1h backfill a chunk per sweep and save each chunk (TRDD-ORGJ0E3G)
802531dd feat(bodies): pair a response with its request by request_body_id when present (TRDD-ZQQYRYBO I12a)
079f7839 feat(context): count instructions and prompt_snapshot attachments (TRDD-ZQQYRYBO I9)
5b272f77 fix(cli): hook-context-cost counts dispatches, not hook fires (TRDD-ZQQYRYBO I15)
f101fe50 fix(cli): hook-context-cost labels match what the event carries (TRDD-ZQQYRYBO I15)
86f4fa22 fix(ingest): backfill the 1h cache-write tier from usage only, never re-parse cards (TRDD-ORGJ0E3G, TRDD-TWDGR75R)
97cb873d fix(cli): make hook-context-cost say what its numbers are (TRDD-ZQQYRYBO I15)
e48e49c6 fix(skill): put the Monitor deadline and re-arm rule back in the skill body (TRDD-ZQQYRYBO I16)
eb1bbc35 docs: card the gaps the I9b review and main-tree verify found (TRDD-2D3D2V9F, TRDD-YVJYOJ81, TRDD-Q4ZMJD88, TRDD-DGLBZRBR, TRDD-Z228SAC7)

## Acceptance

- [x] CHANGELOG [Unreleased] has entries for the alignment commits after ef1577b6 (00e12331); checklist written from the card's own next-action text at close time, 2026-10-04.
