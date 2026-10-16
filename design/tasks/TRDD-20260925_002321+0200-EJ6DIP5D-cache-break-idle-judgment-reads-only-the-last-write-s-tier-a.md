---
trdd-id: EJ6DIP5D
title: Cache-break idle judgment reads only the last write's tier and overstates expiry after mixed writes
column: todo
status: tasked
created: 2026-09-25T00:23:21+0200
updated: 2026-10-16T11:16:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:23:21+0200
implementation-commits: [76e5b134]
---

# Cache-break idle judgment reads only the last write's tier and overstates expiry after mixed writes

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Facts: I6c2 (TRDD-ZQQYRYBO) judges an idle gap by the tier of the last turn that wrote the cache. If an earlier 1h write is followed by a later 5m write and then a 5-60 min gap, the turn is reported as a full IDLE_TTL_EXPIRY although part of the prefix is still resident. The cost figure is still correct; only the cause label can be too strong.

Evidence: reports/cc-alignment/20260924_234821+0200-I6c2.md
2026-09-25: Rule now being implemented: within the current prefix segment (back to the last cold full rewrite, cache_read == 0 with a write), if the last write is all-5m and the gap is over 5 min and at most 1h, and an earlier write in the segment had a nonzero 1h slice or an unobserved tier, ttlGapSource becomes 'assumed'; the cause is unchanged. The mirror direction (earlier 5m, later 1h) is correct as is. This card must NOT close on this change: the cause may still be overstated, because whether the earlier 1h entry survived is uncertain (a hit refreshes the entry it matched). The segment boundary can be tripped by interleaved subagent turns, which depends on TRDD-WBT2WW96.
2026-09-25T14:17:04+0200: Implementation verified and committed as 76e5b134 (mixed-tier writes in the same prefix segment now label the idle gap 'assumed'; TS 7 tests + Rust 3 tests + 2 fixture cases, mirror-direction control, off-screen-segment case; full crate cargo 682 passed / 0 failed; mocha cacheBreak+cacheBreakTimeline 23+72 passing; the 16 unrelated mocha failures are the pre-existing carded ones). Remaining before close: the cause-label itself can still overstate — whether the earlier 1h entry actually survived is uncertain (a hit refreshes the entry it matched) — and the segment boundary can be tripped by interleaved subagent turns (TRDD-WBT2WW96). Card stays open on those.
OPEN LIMIT (adversarial review of 76e5b134, 2026-09-25): the mirror direction (earlier 5m, later all-1h) is treated as correct because the all-1h write 'covers the whole prefix' — but that holds only for a full rewrite. An all-1h APPEND (small cacheCreate at the 1h tier) rewrites only the suffix; the pre-append prefix stays covered by the earlier 5m entry, which can expire during the gap while the label claims 'measured'. One direction of the bug class this card exists for remains.

## Approval log

- 2026-09-25T00:23:21+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-25T05:34:00+0200 — column → dev by main-agent@agentlenspro. owner default taken 2026-09-25: label 'assumed' on mixed-tier writes
- 2026-10-16T11:13:12+0200 — column → todo by main-agent@agentlenspro. work stalled mid-way or never started; no one works it now; triage row 29

## Notes and lessons learned

2026-10-16: moved to todo by the board triage (row 29). What remains: The open limit, or an explicit owner acceptance of it; neither recorded.
