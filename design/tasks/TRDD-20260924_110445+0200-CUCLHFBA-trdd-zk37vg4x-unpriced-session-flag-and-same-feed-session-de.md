---
trdd-id: CUCLHFBA
title: TRDD-ZK37VG4X unpriced-session flag and same-feed session dedup were never ported to rust-core
column: backburner
created: 2026-09-24T11:04:45+0200
updated: 2026-09-24T11:11:24+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: false
mandated-by: none
approved: false
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T11:04:45+0200
---

# TRDD-ZK37VG4X unpriced-session flag and same-feed session dedup were never ported to rust-core

flagUnpricedSessions and dedupeSessionIdentities (TRDD-ZK37VG4X spec 1 and spec 2) lived only in src/sessionRepository.ts, deleted by TRDD-4BZPAQWM commit A (a81972f9) along with the only TS-side executable specs for them (src/test/database/sessionIdentity.test.ts). rust-core has no equivalent of flagUnpricedSessions anywhere (grepped for flag_unpriced/flagUnpriced/ZK37VG4X, zero hits; the 'unpriced' concept in ccevent_parity.rs/ccforensics_parity.rs is a different, unrelated cost-attribution path). feed_merge_parity.rs covers only the CROSS-FEED merge doctrine that overlaps with dedupeSessionIdentities's first two test cases; the SAME-feed, byte-identical-usage, 10-minute-window dedup (5 other test cases: exact-match collapse, window-boundary separation, fingerprint mismatch, zero-traffic guard, model-in-fingerprint) has no rust-core equivalent at all. Whether feed_merge.rs detects cross-feed twins by the same usage fingerprint and 10-minute window (zero-traffic guard, model in the fingerprint) is unverified — check before assuming the cross-feed half is covered. This gap predates TRDD-4BZPAQWM — sessionRepository.ts was never ported to Rust in the first place; deleting the dead TS only removed the last TS-side spec of the gap, it did not create it. The old executable spec is recoverable with: git show a81972f9^:src/test/database/sessionIdentity.test.ts. First step for whoever picks this up: establish whether alcore actually needs this behaviour at all before porting anything. Evidence: reports/4BZPAQWM/20260924_105917+0200-commit-a-implementation.md, section 'Rust-core equivalence check'.

## Approval log

- 2026-09-24T11:04:45+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-09-24T11:11:23+0200 — CORRECTION: the MANDATE line above was stamped by trddgrep from the OS account (TRDD-FK4AXP7M); no owner mandated or approved this card; an agent created it during TRDD-4BZPAQWM.
