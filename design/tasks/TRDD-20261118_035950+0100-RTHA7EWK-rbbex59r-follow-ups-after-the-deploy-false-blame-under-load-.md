---
trdd-id: RTHA7EWK
title: RBBEX59R follow-ups after the deploy - false blame under load, operations.md enable cases, test nits, d3 wording
column: todo
status: tasked
created: 2026-11-18T03:59:50+0100
updated: 2026-11-18T05:30:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T03:59:50+0100
parent-trdd: RBBEX59R
---

# RBBEX59R follow-ups after the deploy - false blame under load, operations.md enable cases, test nits, d3 wording

Four items moved here from the gate checklist of TRDD-RBBEX59R (its boxes 5 to 8) on 2026-11-18, so that the card can close on its gates and its deploy. Item 2 is a gap in a user-facing document and is owed before the next publish (TRDD-HSPUF5XH).

## Checklist

- [ ] (from box 5) False blame under load: a skipped flush (the TimedOut arm of the 8 s budget) makes the Rust read-back and joint leg 9 fail as 'not stored' although the sample was accepted; add self.log_text() to the Rust assert message in rust-core/crates/agentlens-core/tests/no_collection_boot.rs and point the failure of leg 9 at server.log.
- [ ] (from box 6) skills/agentlenspro-diagnostics/references/operations.md near line 97: say how to get collection back in the three cases where the server stays in no-collection mode after enable (NO_REVIVE: lift it, then agentlenspro server restart; AGENTLENS_DISABLED=1: unset it; the env-resolved data dir differs from the one enabled); follow through the 'no server answers' case (the next hook revives it in collection mode); '(honoured)' is vague; the first new line is about 146 characters against about 130 for its neighbours.
- [ ] (from box 7) Nits: the header comment of rust-core/crates/agentlens-core/tests/no_collection_boot.rs still describes a counter-only test; confirm Server Drop ignores kill and wait errors on an already-reaped child; a torn last ndjson line panics in unwrap instead of failing the assert; REVIVE_LOCK_TTL_MS is exported from src/cli/hookHandlers.ts only for a test; the A12 and server-down tests use a freePort() released before use (small bind race, accepted so far); these tests require alcore to exit within 60 s of SIGTERM (no_collection_boot.rs:83-85 fails the assert otherwise).
- [ ] (from box 8) d3 wording: the foreign-lift clause under the env half (pinned in 761efb90 in src/test/autoSetup.test.ts) was on the d3 wording list and the d3 worker reports name no change to it; check the wording against the launch text and either change it or record why it stays.
- [ ] (item 5, from TRDD-VS1FCUMU Known limits) A write-ahead file that the sealer refuses is retried with no bound and nobody is told: add a per-file failure marker with a backoff (the sealer skips the file while the marker is young), keep the error text that seal_one drops today (statusline_store.rs, the Err arm of run), give the hook-started sealer a log file in place of stdio ignore, and show refused files in agentlenspro doctor. A test must make a file unsealable and assert one attempt per backoff window.
- [ ] (item 6, from TRDD-VS1FCUMU OPEN 2) Update the memory page .claude/project/memory/statusline-capture-and-store.md for the no-server store (lines 177-179 were named in the VS1FCUMU note; not re-read since): through a memgrep verb, by a worker, then commit it.
- [ ] (item 7, from TRDD-VS1FCUMU OPEN 1) CHANGELOG Not covered gains the cache-verb exit 2 after a seal (TRDD-ETFX9JFM); owed before the publish (TRDD-HSPUF5XH).

## Approval log

- 2026-11-18T03:59:50+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
