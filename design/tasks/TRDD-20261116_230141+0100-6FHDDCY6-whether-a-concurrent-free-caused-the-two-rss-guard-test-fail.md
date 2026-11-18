---
trdd-id: 6FHDDCY6
title: Whether a concurrent free caused the two rss_guard test failures is not established
column: backburner
status: tasked
created: 2026-11-16T23:01:41+0100
updated: 2026-11-16T23:01:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:01:41+0100
---

# Whether a concurrent free caused the two rss_guard test failures is not established

## Why this card exists
Moved here from TRDD-10NGH2BR by the owner-stead decision of 2026-11-16 (owner order, verbatim: "review in my stead. decide yourself."). That card's fix (cc0cee02, the test runs alone in its own process) does not depend on the answer. Reopen this card if the failure comes back.

## Acceptance
- [ ] The cause is confirmed or refuted by Linux runs with --test-threads=1 against default threads (runs recorded).

## Results carried over from TRDD-10NGH2BR (copied whole)
2026-10-15, Linux at 8a9e472f, test still in the lib binary (reports_dev/linux-rss-8a9e472f.md): 0 failures in 60 runs (30 isolated, 20 full lib with default threads, 10 full lib with --test-threads=1), on a heavily loaded host where the default-thread full-lib runs took 40 to 230 s against 15 to 50 s at 84f3b0f8. These runs do not separate the causes. The earlier rate was 2 of 10 full-lib runs at 84f3b0f8.
2026-10-15, mechanism probe at 8a9e472f, in a scratch export only (reports_dev/linux-rss-mechanism.md): a helper thread freeing 64 MiB between the two readings failed the test's threshold in 30 of 30 iterations (growth 0 to 196608 bytes); the original body and a free just before the first reading failed 0 of 30 each. A large concurrent free is therefore sufficient to defeat the test's measurement; that it caused the two observed failures, which were partial (growth 32075776 and 16826368 bytes), is not established.

## Approval log

- 2026-11-16T23:01:41+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
