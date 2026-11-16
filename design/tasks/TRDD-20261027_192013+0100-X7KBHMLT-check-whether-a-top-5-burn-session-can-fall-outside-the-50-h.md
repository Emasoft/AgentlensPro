---
trdd-id: X7KBHMLT
title: Check whether a top-5 burn session can fall outside the 50 hot timeline cards
column: todo
status: tasked
created: 2026-10-27T19:20:13+0100
updated: 2026-10-27T19:53:49+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T19:20:13+0100
---

# Check whether a top-5 burn session can fall outside the 50 hot timeline cards

Derived from TRDD-735Q3JF4 (open item (b)). Burn status counts only timeline api_request entries (burn/monitor.rs api_request_events), and demote_cold_timelines keeps timelines only on the timeline_hot_cards() = 50 most recently active cards (summarize/retention.rs). Question: which in-window sessions lose their timeline events, through the 50-card cap or through the 24 h hot-age strip (log parsing strips the timeline of a card inactive for more than 24 h: summarize/retention.rs timeline_hot_age_ms, log_reader.rs:85-88; taken from the TRDD-735Q3JF4 investigation report, not yet read by this card's author), and what share of the 5h and 7d burn does that drop? In particular, can a top-5 burn session be among them? Old and new builds share this, so it is not an old-vs-new defect. Suggested check: a fixture with more than 50 timelined cards, call demote_cold_timelines(50), and assert the top-5 burn sessions computed before demotion are still present after it; or a read-only query on a copy of the store. Evidence 2026-10-27 (TRDD-735Q3JF4 acceptance repeats, report docs_dev/20261027_195023+0100-735Q3JF4-inc1-acceptance-repeat-report.md): a copy of the live store held 32 cards with timeline_len > 0, the newest active at 11:54 the same day (inside 7 d), yet /api/burn-status reported an empty 7d window in BOTH the old (r36) and new builds. Cause not determined; candidates: (a) the 32 timelines hold no api_request entries (e.g. non-Claude cards, or message/tool entries only; claude.rs:528 inserts api_request for Claude log cards only); (b) their api_request entries are older than 7 d although last_active is inside it; (c) timeline_len counts a stored timeline that parsed_cards or the burn subset does not load at a --no-log-scan boot, so the in-memory card is empty; (d) none of them maps to an account. A read-only query on a copy counting api_request entries per hot timeline settles (a) and (b) in one step.

## Approval log

- 2026-10-27T19:20:13+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
