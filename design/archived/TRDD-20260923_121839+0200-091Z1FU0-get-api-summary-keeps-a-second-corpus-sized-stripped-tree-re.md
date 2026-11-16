---
trdd-id: 091Z1FU0
title: GET /api/summary keeps a second corpus-sized stripped tree resident and costs about 340 MB per read
column: complete
created: 2026-09-23T12:18:39+0200
updated: 2026-10-22T06:20:19+0200
current-owner: main-session
created-by: main-session
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T12:18:39+0200
implementation-commits: [c16e5283, 4490a6bb, 04988cef]
status: archived
---

# GET /api/summary keeps a second corpus-sized stripped tree resident and costs about 340 MB per read

Symptom: one GET /api/summary at ~11:59 on 2026-09-23 raised phys_footprint 1.70 -> 2.04 GB (peak 2,144 MB) and a guard exit followed at 12:03:14 (uptime 640 s); causation not proven.

Suspected path (? INFERRED, to verify): ui.rs `stripped_now` (~465-478) stores the stripped tree in `stripped_cache` (resident until the next version), `strip_session_detail` copies every card, then `.to_string()` serializes ~47 MB.

Scope: measure first on an isolated instance (reads are +340 MB each, so never probe the live collector); fix follows from the measurement (pagination belongs to TRDD-KBM09XHB).

Evidence: docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md §3.3 and §7.

related: [MBQ9LXAN, 7RM5YW2T, KBM09XHB, WKLD508O]

## Approval log

- 2026-09-23T12:18:39+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-22T06:08:37+0200 — column → testing by main-agent@agentlenspro. landed and A/B measured; deploy pending
- 2026-10-22T06:20:19+0200 — COMPLETE by main-agent@agentlenspro. landed, A/B measured, deployed; crash loop tracked on 2JOIAH2G.

## 2026-09-23T12:41:07+0200 — verified in code: the deep clones and their call path

strip_session_detail (ui.rs, called by stripped_now -> GET /api/summary, by CoreState::build_stripped_summary, and by build_update_payload) deep-cloned the whole summary with obj.clone() (timelines included) only to overwrite sessions, then cloned each session in full before dropping fileOps/generatedFiles/generatedFilesTruncated; c16e5283 removed both throwaway copies with byte-identical output. Still open for this card: the stripped tree kept resident in stripped_cache, the ~47 MB .to_string(), and a measurement of the per-read cost.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-23T12:47:16+0200
STATE 2026-10-22: implemented and A/B-measured (see Result). NEXT ACTION: deploy the 04988cef alcore to the live collector, then close.



## Result 2026-10-22

Landed: 4490a6bb (StrippedView adapter, byte parity tests, mutation-proven) and 04988cef (twin deleted from engine, caches, stats and composition line; engine previous-output check now a Weak<Value> plus ptr::eq, because a bare usize address was recycled by a foreign Arc in a new test).
A/B, 4 isolated runs from one frozen snapshot (docs_dev/20261022-091Z1FU0-ab-result.md): footprint at 120 s old 4807.5 MB vs new 4564.5 MB (-243 MB; within-arm spread old 229, new 85); mi live at 120 s 3877 vs 3506 MB (-371 MB); per-read peak delta 211.8 vs 205.0 MB (no change).
The prediction 'up to half the live heap' was wrong: the twin was about 250-370 MB. The per-read spike is the serialization of the 75 MB body, not the twin. This does not touch the 9-18 s crash-loop kills of TRDD-2JOIAH2G (the twin is built at 25-35 s).
INFERRED, not verified: the old two-pointer check had the same latent address-reuse hole; the claim in 04988cef's message that it was harmless in practice rests on review inference only.
Not deployed to the live collector yet. CHANGELOG skipped: only debug surfaces changed (derivedCaches.stripped field, composition line).

## Deploy (2026-10-22)

06:12 local: binary built at HEAD 04988cef deployed to bin-native/darwin-arm64/alcore (strings: no stripped-cache, new expect message present; provenance by content and build time 05:51, not by sha, because re-signing changes the sha). Rollback copy alcore.pre-twin-20261022 is the 44bc67e1 build. codesign verify exit 0; no-args exit 64.
The collector did not survive: the 2 GB RSS guard fired about 22 s after boot (footprint 2840 MB, mimalloc commit 2078 MB, 56,835 card rows). Same crash loop as the previous binary (TRDD-2JOIAH2G); this change targets steady-state memory and cannot affect kills that happen before the summary is built. No rollback: the old binary crash-loops identically.
No new alcore .ips crash report at or after the 06:12 restart; the stop step produced none this time.
Correction: the Result's statement that the per-read spike is the serialization of the 75 MB body is INFERRED (no allocation attribution was made); what was measured is only that removing the twin did not change the per-read peak (211.8 vs 205.0 MB, 4 runs).

## Acceptance

- [x] Per-read cost measured on isolated instances, never the live collector (docs_dev/20261022-091Z1FU0-ab-result.md)
- [x] The throwaway deep clones in strip_session_detail removed with byte-identical output (c16e5283)
- [x] The stripped tree is no longer kept resident: stripped_cache and the engine twin deleted (04988cef); /api/summary and the shell serialize through StrippedView with byte parity tests (4490a6bb)
- [x] Serialization of the summary body itself remains per read; it moves to pagination under TRDD-KBM09XHB
- [x] Deployed to the live collector 2026-10-22 06:12; provenance by content and build time (see Deploy section)
