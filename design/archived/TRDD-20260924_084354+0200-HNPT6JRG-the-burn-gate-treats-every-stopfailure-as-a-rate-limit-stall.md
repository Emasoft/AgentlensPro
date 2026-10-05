---
trdd-id: HNPT6JRG
title: The burn-gate treats every StopFailure as a rate-limit stall and blocks fresh agents machine-wide
column: complete
created: 2026-09-24T08:43:54+0200
updated: 2026-10-05T11:24:37+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T08:43:54+0200
related: [0D6QK5CW, 8ENYLEIO, L58CKPC3]
implementation-commits: [78e84e7f, 0b41bb98]
status: archived
---

# The burn-gate treats every StopFailure as a rate-limit stall and blocks fresh agents machine-wide

## Approval log

- 2026-09-24T08:43:54+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-24T08:58:05+0200 — column → ai_review by main-session. Fix landed and deployed (commit 78e84e7f); follow-up review needed on cold-resume clock scope, agentgate_parity fixture coverage, and integration test gap
- 2026-10-05T11:24:37+0200 — COMPLETE by main-agent@agentlenspro. review of 2026-10-05 in the owner's stead, see the Review section.

## Defect

rust-core/crates/agentlens-core/src/burn/agent_gate.rs:751 (build_gate_state) took ANY StopFailure hook event, from any session on the machine, as the last rate-limit stall (lastStopFailureMs, agent_gate.rs:813). That arms COLD_RESUME_FANOUT and denies fresh agent launches machine-wide for the cold-resume window. The same server's calibrator already classifies these events (burn_calibration.rs:45 is_rate_limit_stop_failure; burn_calibration.rs:136 logs 'StopFailure error is not rate-limit-class'). Observed 2026-09-24: every lean-worker launch refused for 20+ minutes while server.log showed only non-rate-limit-class StopFailures.

## Acceptance

- [x] (a) a non-rate-limit StopFailure no longer sets lastStopFailureMs
- [x] (b) a rate-limit-class StopFailure still does (newest wins)
- [x] (c) unit tests pin both, and fail with the filter removed
- [x] (d) clippy on agentlens-core with -D warnings is clean

## Deployment and follow-ups

Deployed 2026-09-24 (alcore pid 10262); lean-worker launches confirmed allowed again right after. The only StopFailures on record for this session are model_not_found (7), authentication_failed (2), invalid_request (1) — none rate-limit-class; the regex rate.?limit matches the CC enum value rate_limit, so the calibrator's classifier and the fix's filter agree on these. Open follow-ups raised in review, not yet actioned: the cold-resume stall clock is still machine-wide, not per-account; agentgate_parity's fixture carries no non-rate-limit StopFailure case, so the TS and Rust gates can still diverge outside what that fixture covers; there is no integration test exercising build_gate_state end to end.

## Review 2026-10-05 (in the owner's stead)

- Verdict ACCEPT after two added tests (commit 0b41bb98, written by the reviewing session). Run by the main agent: `cargo test -p agentlens-core --lib stall_filter` exits 0 with 4 passed, at a 1-minute load of 55, above the session's own limit of 20; the tests are not timing-dependent. Read by the main agent: last_rate_limit_stop, the call in build_gate_state and the lines that copy the chosen event's ts into lastStopFailureMs, all four tests, and the raw hooks documentation, which names the payload key `error` that the classifier reads.
- The review found the two original tests call the helper only. With build_gate_state made to pick the newest StopFailure of any class, the two helper unit tests and the endpoint test agent_gate_route_fail_open_deny_warn_advisory_and_dedupe all stayed green. The two added tests go through build_gate_state; under the same mutation both fail by name (1000.0 where null is expected; 1500.0 where 1000.0 is expected). All of that was read by the main agent in the worker's captured outputs, not run by it. Three mutations inside the helper each turn a test red (worker's report). `cargo clippy -p agentlens-core --all-targets -- -D warnings` after the tests were added: the worker's capture records exit 0 and a clean finish; the main agent read the capture and did not run it.
- Not verified: that the running collector holds the fix. By its date the binary on disk (2026-10-03) is later than commit 78e84e7f; the process named in the deployment note above is no longer the one running.
- Limits of the added tests: each opens a core state on its own temporary folder and removes it, but a failing assertion skips the removal and leaves the folder behind. Opening a core state gives the burn runtime the real home directory, as every existing test that opens one does; build_gate_state reads a bodies report and TTL context through it. The asserted value is a copy of the chosen event's timestamp and does not depend on them; what those reads touch was not traced.
- Follow-ups: the machine-wide clock is carried by TRDD-L58CKPC3. The parity generator supplies lastStopFailureMs directly and the TypeScript gate only reads it (workers' reads), so no card is opened for parity; the reviewing session's decision. The integration-test follow-up is met at unit level by the added tests; by a worker's read nothing posts a StopFailure through the HTTP endpoint and asserts on the gate, and no card is opened for that.
