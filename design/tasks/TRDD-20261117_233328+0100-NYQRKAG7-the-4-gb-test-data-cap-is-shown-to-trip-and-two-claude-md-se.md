---
trdd-id: NYQRKAG7
title: The 4 GB test data cap is shown to trip and two CLAUDE.md sentences about it are stale
column: todo
status: tasked
created: 2026-11-17T23:33:28+0100
updated: 2026-11-17T23:43:26+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T23:33:28+0100
---

# The 4 GB test data cap is shown to trip and two CLAUDE.md sentences about it are stale

## Problem
Goal set by the owner on 2026-11-17: verify that the 4 GB cap on test data is always enforced. CLAUDE.md said that the guard and the proof tests "prove COVERAGE only, never that the cap trips", and its recipe to run one mocha file fails as written.

## Evidence (2026-11-17, HEAD 11f179ed, main agent, every output read whole)
- TRIP. `mocha --no-config --ui tdd --timeout 10000 --require src/test/setup.js out/test/test/testDataCap.test.js`: 2 passing, exit 0, 7 s. The test "the cap trips" runs a copy of scripts/test-data-cap.sh that differs from the original in exactly one line (CAP_KB 4194304 to 10240; the test asserts the one-line difference), with a writer of 1 MiB per 0.3 s and a background child in the same process group. It asserts exit 3, the stderr line "exceeds the 4 GB cap", the run dir removed and no writer alive. Output: reports_dev/test-data-cap/20261117_233041+0100-trip-test-run.txt (script md5 e59b177e8216e4363e82fb06a07874d1, compiled test md5 ac12b48af020d259ee18defdb7659430).
- COVERAGE in the same run. The first test passed with AGENTLENS_TEST_CAP_DIR unset before the run, so the self-wrap of src/test/setup.js put a bare mocha under the wrapper.
- GUARD. `node scripts/check-test-cap.js`: exit 0, "OK — 282 rust files, 255 test files, package.json + 3 workflows scanned; 1 mkdtemp exemption(s)".
- CARGO. .cargo/config.toml read whole (runner = the cap script). The runner line is in the verbose output of the two cargo test runs of 2026-11-17 before the reboot (reports_dev/PGMMB2QG/build-raw-main/incB-01-lib-log_reader.txt and incB-02-test-card_reuse.txt, one line each). Not run again after the reboot.
- The cap is a constant in the script (CAP_KB=4194304); the script reads no environment variable for it.

## Limits: what "always" does not cover
- The trip is shown on a copy with the cap lowered to 10 MiB. A trip at the real 4 GiB was not run: it needs a test that writes more than 4 GB, which the cap rule forbids.
- The trip test covers the process-group kill only. The net for daemons that leave the group (kill_stragglers) is not covered; the comment of the test says so.
- The size is sampled every 5 s, so a fast writer can overshoot between two samples.
- Only files under TMPDIR, TMP and TEMP are counted. A test that writes to its own DATA_DIR or HOME outside TMPDIR, or to a hardcoded path, is not counted; the guard finds only mkdtempSync on a literal /tmp.
- Measurement scripts run outside tests are not wrapped. Cumulative writes of a load generator: TRDD-H9UX6HFB.
- The first attempt used the CLAUDE.md recipe as written (no `--ui tdd`) and failed before any test ran: "ReferenceError: suite is not defined", mocha exit 1 (reports_dev/test-data-cap/20261117_233019+0100-trip-test-run.txt).

## Acceptance
- [x] The trip test is run alone and passes (output above).
- [x] The coverage guard passes.
- [x] CLAUDE.md: the sentence "prove COVERAGE only, never that the cap trips" names the trip test and its limit, and the recipe for one mocha file includes `--ui tdd`.
- [ ] The Rust proof test (agentlens-spool/tests/test_data_cap.rs) is run once after the reboot, under the cargo gate.

## Approval log

- 2026-11-17T23:33:28+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-17T23:43:23+0100 The CLAUDE.md recipe was verified with --timeout 10000 on the command line; --no-config drops the 10 s timeout of .mocharc.cjs too (mocha falls back to 2 s), and the recipe line does not say so. A test file that relies on the 10 s timeout needs --timeout 10000 added. Not put into CLAUDE.md yet.
