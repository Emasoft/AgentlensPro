---
trdd-id: 10NGH2BR
title: rss_guard primary_metric test fails intermittently when parallel tests free memory during its measurement
column: human_review
status: tasked
created: 2026-10-15T14:53:47+0200
updated: 2026-10-15T18:49:35+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T14:53:47+0200
implementation-commits: [cc0cee02]
---

# rss_guard primary_metric test fails intermittently when parallel tests free memory during its measurement

## Approval log

- 2026-10-15T14:53:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T18:32:22+0200 — column → human_review by main-agent@agentlenspro. box 2 met; boxes 1 and 3 need an owner decision on changed wording

## Problem

rss_guard::tests::primary_metric_reports_a_real_measurement_never_zero (rust-core/crates/agentlens-core/src/rss_guard.rs) dirties 64 MiB and asserts that the process memory metric rose by more than 32 MiB. On linux/amd64 (emulated, Debian) at 84f3b0f8 it failed 2 of 10 full lib runs: rss moved only 32075776 bytes (685559808 -> 717635584) and only 16826368 bytes (698994688 -> 715821056) after dirtying 67108864 (reports_dev/linux-7eze-runs-84f3b0f8/fulllib-05.txt and fulllib-07.txt). It passed 3 of 3 at f7a4945a and in every macOS run seen this session. CI (ubuntu-latest, cargo test --workspace, no retry) has never run it, since CI has not run since 2026-09-02.
Inferred, not checked: the metric is process-wide and the lib tests run as parallel threads of one process, so memory another test frees during the measurement can offset the 64 MiB rise. It is the same class as TRDD-7EZE3AIZ.

## Fix direction

Confirm the cause first with --test-threads=1 runs on Linux against default threads. Then measure where nothing else runs, for example a single-test integration binary as tests/lock_holder_site.rs does, if the metric is reachable from outside the crate; or make the measurement immune to concurrent frees. Never lower the threshold to a point where a metric that does not track memory could pass.

## Acceptance

- [ ] The cause is confirmed or refuted by Linux runs with --test-threads=1 against default threads (runs recorded).
- [x] Other tests in the process can no longer fail it, and a metric that does not track memory still fails it (mutation recorded).
- [ ] 20 consecutive full lib runs on Linux show zero failures of this test.

## Results

2026-10-15: cc0cee02 moves the test into tests/rss_guard_metric.rs, an integration binary holding only this test, so no other test runs in its process; the body and its threshold are unchanged, and src/rss_guard.rs keeps a one-line pointer to the new file.
2026-10-15, mutations on macOS, on a working tree whose src/rss_guard.rs and tests/rss_guard_metric.rs are byte-identical to cc0cee02 (reports_dev/rssmv-report.md): M1, primary_metric returning ("rss", 0), failed the new test with "rss did not rise after dirtying 67108864 bytes"; M2, 16 MiB dirtied against the fixed 33554432-byte threshold, failed it with "moved only 16826392 bytes". Both sources were restored cmp-identical. The new test passed 10 of 10 on macOS, and the lib binary passed without it.
2026-10-15, Linux at cc0cee02 (rust:1 image, emulated linux/amd64, rustc 1.99.0, rebuilt after cargo clean -p agentlens-core): the new test passed 20 of 20 runs in its own binary, with no "rss moved only" line; the lib binary ran 108 tests, and the test name appears 0 times in the workspace output (reports_dev/linux-rss-cc0cee02.md).
2026-10-15, CI discovery: cargo metadata lists rss_guard_metric as a test target of agentlens-core, and the crate's Cargo.toml has no autotests or [[test]] entries, so CI's cargo test --manifest-path rust-core/Cargo.toml --workspace (ci.yml:299) runs it. The Linux workspace run meant to show this stopped at tests/log_reader_parity.rs, whose test reads src/collectorState.ts, a file the rust-core-only export lacked; cargo stops at the first failing binary, so the new binary never ran there. At cc0cee02 the files the export lacked exist (src/collectorState.ts, src/shared/pricing.ts, media/index.html), and the LOG_INGEST_VERSION constant that test compares is 7 on both sides (src/collectorState.ts:57, rust-core/crates/agentlens-core/src/log_reader.rs:698). CI's command has no --no-fail-fast, so a failing binary that sorts earlier would still keep this one from running.
2026-10-15, Linux at 8a9e472f, test still in the lib binary (reports_dev/linux-rss-8a9e472f.md): 0 failures in 60 runs (30 isolated, 20 full lib with default threads, 10 full lib with --test-threads=1), on a heavily loaded host where the default-thread full-lib runs took 40 to 230 s against 15 to 50 s at 84f3b0f8. These runs do not separate the causes. The earlier rate was 2 of 10 full-lib runs at 84f3b0f8.
2026-10-15, mechanism probe at 8a9e472f, in a scratch export only (reports_dev/linux-rss-mechanism.md): a helper thread freeing 64 MiB between the two readings failed the test's threshold in 30 of 30 iterations (growth 0 to 196608 bytes); the original body and a free just before the first reading failed 0 of 30 each. A large concurrent free is therefore sufficient to defeat the test's measurement; that it caused the two observed failures, which were partial (growth 32075776 and 16826368 bytes), is not established.

## Owner decision needed

2026-10-15: box 2 is ticked on the first three Results lines. Boxes 1 and 3 stay open, because closing them changes what they ask for, and the agent does not approve that on its own.
Box 1 asks for the cause to be confirmed or refuted by --test-threads=1 runs against default threads. Those runs were made (Results, the 8a9e472f line) and did not reproduce the failure in either arm, so they can neither confirm nor refute it. Proposed: move box 1 word for word to a new backburner card carrying the 8a9e472f and mechanism-probe Results lines, to reopen if the failure recurs; this card then closes without it. Alternative: reword box 1 to say a large concurrent free is shown sufficient and its link to the two observed failures is not established.
Box 3 asks for 20 consecutive full lib runs on Linux with zero failures of this test. Since cc0cee02 the test is no longer in the lib binary. Proposed: accept the 20 of 20 Linux runs of its own binary at cc0cee02 in its place, since that binary is what CI runs. Twenty clean runs bound the failure rate only below about 14% at 95% confidence.
The card moves to human_review for this decision.

## Notes

2026-10-15: this card was worked entirely while in column todo; it never passed through dev, testing or ai_review.
2026-10-15: the message of commit ac4ca857 overstates two points this card states correctly: cc0cee02 removes only the shared-process failure path (other tests in the same process offsetting the measurement), not every way the test can fail; and the 64 MiB concurrent free in the mechanism probe defeated the test's measurement in a separate probe binary, not the test itself.
