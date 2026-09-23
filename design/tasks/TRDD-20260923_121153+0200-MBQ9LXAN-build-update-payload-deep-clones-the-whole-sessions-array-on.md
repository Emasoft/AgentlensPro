---
trdd-id: MBQ9LXAN
title: build_update_payload deep-clones the whole sessions array on every SSE update frame
column: todo
created: 2026-09-23T12:11:53+0200
updated: 2026-09-23T12:18:27+0200
current-owner: main-session
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-23T12:11:53+0200
---

# build_update_payload deep-clones the whole sessions array on every SSE update frame

## Symptom
build_update_payload runs ONLY for the SSE `update` frame -- `sse_response` (initial frame on connect) and `push_update` (every ~4 s while >=1 dashboard client is connected), rust-core/crates/agentlens-core/src/ui.rs:537 and :1020 (verified by `tldr impact build_update_payload`); `GET /api/summary` does NOT call it. Each frame deep-clones ~22,925 session Values (the stripped summary is ~47 MB as text, ~170 MB parsed) only to pass a slice to compute_analytics_data. Cost per frame NOT yet measured. The +340 MB seen on one /api/summary read belongs to a different path -- see the new card from step 2.

## Cause
`rust-core/crates/agentlens-core/src/update_payload.rs` `build_update_payload` (~line 262) does `summary.get("sessions").and_then(Value::as_array).cloned()` -- a deep copy of ~22,925 session Values -- only to pass a slice to `compute_analytics_data(sessions: &[Value])`.

## Fix
Borrow the slice (`.map(Vec::as_slice).unwrap_or(&[])`), no clone. Out of scope: `strip_session_detail`'s necessary output copy and `stripped_cache` residency (separate).

## Evidence
docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md §3.3 (gitignored, local).

## Acceptance
- [ ] clone replaced by a borrow with a why-comment at the site
- [ ] `events_streams_the_ping_then_update_frames_on_connect_and_on_the_coalesced_push` (rust-core/crates/agentlens-core/tests/ui.rs) and tests/update_payload_parity.rs green; clippy shows no new warning versus HEAD
- [ ] deployed with the binary verified (codesign, `--version` exit 0, running pid's mapped inode == file inode)
- [ ] per-frame footprint spike measured with one SSE client on an isolated instance, old binary vs new

## Related
related: [7RM5YW2T, WKLD508O, KBM09XHB]; relevant-rules empty.

## Approval log

- 2026-09-23T12:11:53+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
