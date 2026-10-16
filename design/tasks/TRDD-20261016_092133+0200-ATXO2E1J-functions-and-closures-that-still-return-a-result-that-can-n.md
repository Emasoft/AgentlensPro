---
trdd-id: ATXO2E1J
title: Functions and closures that still return a Result that can no longer fail after TYJSS45N
column: todo
status: tasked
created: 2026-10-16T09:21:33+0200
updated: 2026-10-16T09:40:31+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T09:21:33+0200
project-id: agentlenspro
---

# Functions and closures that still return a Result that can no longer fail after TYJSS45N

After aa61b49d made lock_timed infallible and 4ebb9196 cleaned five functions, closures and pub fns whose only error source was the poisoned lock may still return a Result or Option that is always Ok or Some. clippy::unnecessary_wraps does not inspect closures and skips pub fns under its default avoid-breaking-exported-api = true (INFERRED from clippy's lint configuration docs), so the TYJSS45N close-out lint run proves nothing about them. First step: list every site that held lock_timed().map_err or a let-else on lock_timed before aa61b49d (git show aa61b49d) whose enclosing fn or closure now has no other error source; run clippy -W clippy::unnecessary_wraps with avoid-breaking-exported-api = false in a scratch copy as a cross-check. Then convert each, or record why it stays. Follow-up accepted in the review of 4ebb9196 (TRDD-TYJSS45N).

## Approval log

- 2026-10-16T09:21:33+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] The site list is recorded on this card, and every site on it is converted or has its reason to stay recorded.
- [ ] clippy --workspace --all-targets -D warnings stays clean, and cargo test --workspace passes apart from the watcher-test signatures tracked on TRDD-WBYDQH8K.

## Notes and lessons learned

2026-10-16: created from the accepted review finding on 4ebb9196 (TRDD-TYJSS45N); acceptance added after the review of c5136f6d.
