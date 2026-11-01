---
name: test-flaky-and-ci-red-diagnosis
description: "a test is flaky under load but fails in isolation too / test fails intermittently with identical code / wall clock in a test fixture Date.now re-evaluated / isolate the test n times and count failures / CI is red while local slices were green / forgot to run the callers test suite / contract test broke on refactor / a background pipeline shows no output for 20 minutes and looks hung / tail withholds output until EOF / pipe held open by a leaked child / green on CI but fails locally / recurring maximum call stack size exceeded RangeError / spread into call argument limit Math.max of a large array / fixed it but the error came back / strict-greater tie-break picks the wrong session / flaky under load was a false premise / spool_tap tests time out under load / spool_tap timed out waiting for and never bound its ports under load / aldigest collect may starve the alcore lock holder / parallel test reruns stampede when load dips / spool_tap timeout from CPU starvation, one case sampled / uptime load1 shows the starved host"
ocd: 2026-08-12
lmd: 2026-11-01
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# Diagnosing flaky, red-on-CI, hung and recurring test failures

^ATOM-E5VV-1E9P [desc:"a fixture re-reading Date.now() across the code's own setImmediate yield; and 'flaky under load' was a false premise — it failed 7/20 in isolation", keywords: flaky_test_under_load test_fails_intermittently_identical_code wall_clock_in_test_fixture Date.now_re-evaluated_per_call setImmediate_yield_changes_timestamp tie-break_picks_wrong_session isolate_the_test_and_count_failures mine_!==_foreign, ocd: 2026-08-12, lmd: 2026-09-23]

**A test fixture that re-reads the wall clock is nondeterministic wherever the code under test
yields.** `cacheExpiry.test.ts` built its shared timeline as `() => [apiRequestAt(iso(1))]`, so
`Date.now()` was sampled fresh on EVERY call. `getTimeline` runs once per session
(`mcpServer.ts:2013`) and `scanWithBudget` awaits `setImmediate` between items
(`mcpServer.ts:3053`), so the later-processed card got a strictly newer millisecond and the
strict-greater tie-break `ms > newestMs` (`mcpServer.ts:2157`) crowned whichever card the scheduler
reached second. Fix: capture the value ONCE (`const activityAt = iso(1)`).

^ATOM-FF0B-VOQL [desc: "The product's strict-greater tie-break was correct; before calling a test flaky under load, isolate it N times and count", keywords: product_code_was_correct_not_buggy strict_greater_tie_break_is_right isolate_test_and_count_failures flaky_under_load_false_premise 7_of_20_failures_in_isolation load_only_raises_the_rate signposts_walked_past comment_warned_about_this frozen_NOW_already_existed mine_vs_foreign_test_pollution, ocd: 2026-09-23, lmd: 2026-09-23]

**The PRODUCT code was correct and unchanged** — strict-greater over millisecond timestamps with a
real yield is right for real sessions. Two independent signposts had already said so and both were
walked past: the comment two lines above the defect warned that a per-card timestamp "would let the
precision ranking, not the scope filter, decide the winner" (the fixture created exactly that), and
the same file already defined a frozen `NOW` at line 16, "fixed clock so tests are deterministic",
which this one suite did not use.

**The card's premise was the expensive part, not the bug.** Every sighting called it a
full-suite-LOAD flake, which points the search at cross-test pollution. Measured: 7 failures in 20
runs with that ONE test alone in the process; load raises the rate, it was never required. Before
accepting "flaky under load", run it ISOLATED n times and count — the isolated rate is what tells
you whether the nondeterminism is inside the test or between tests. Evidence 7/20 → 0/20. [^1]

^ATOM-LWA9-09CW [desc:"CI red while local slices were green: changing a module's BEHAVIOR contract requires running the suites of its CALLERS, not just the suites of the files you edited (spansScanned flip, ed084ff)", keywords: CI_red_local_green slice_suite_passed_CI_failed forgot_to_run_callers_test_suite contract_test_broke_on_refactor, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

The 9NAUEUUR prefilter changed scanOtelCallEvents' observable contract (spansScanned stopped
counting unparsed spans), and both the worker and the reviewer ran only the suites of the FILES
EDITED (segmentedSpanStore, ndjsonLines) — otelCallEvents.test.ts, which PINNED the old contract,
only ran on CI and went red there. Rule: before claiming green on a behavior change, run the test
suite of every module whose exported function you touched AND of its direct callers (grep the
import); a deliberate contract flip gets the old pin REWRITTEN as a recorded decision, in the same
commit. Landed ed084ff.

^ATOM-KH8H-N8RH [desc:"tail-terminated pipelines look hung when a leaked child holds the pipe; green-on-CI/red-locally means hidden local-state dependency", keywords: background_test_run_empty_output_hang tail_no_output_until_exit pipe_held_open_by_leaked_child green_on_CI_fails_locally timeout_only_on_my_machine, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT read a background pipeline's '20 minutes, empty output' as a hung test run when the pipeline ends in `| tail`: tail withholds EVERYTHING until EOF, and EOF never comes while ANY process keeps the pipe's write end open — a test-spawned child that outlived mocha held it here, so a suite that had finished looked permanently hung and nearly got misdiagnosed as a code regression. DO capture to a file (`cmd > f 2>&1`) and read the file; and when a test is 'green on CI but times out locally', suspect a hidden dependency on local state CI lacks (here: a builder's storeDir defaulting to the developer's real 18-month store).

^ATOM-Y4ZY-Z2V8 [desc:"Spread-into-call RangeError class: recurs across the whole push cycle — sweep the cycle's call graph, not the named file; literal spreads are safe", keywords: maximum_call_stack_size_exceeded_recurred spread_into_call_argument_limit Math.max_spread_large_array summarizeSpans_error_rangeerror fixed_it_but_it_came_back, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT stop hunting a recurring RangeError 'Maximum call stack size exceeded' after fixing the spread sites in the named function's own files, BECAUSE the defect class (spread-into-CALL over an unbounded array — fn(...arr), Math.max(...arr), push(...arr)) recurs anywhere in the same push cycle: after the summarizers were fixed (9da7609) the error came back from computeAnalyticsData's Math.min/max(...times) in standalone/server.ts — same tickBurn→pushUpdate cycle, OUTSIDE the summarizeSpans try/catch. DO walk the ENTIRE call graph of the crashing CYCLE with a plain '\.\.\.'  sweep and review every hit; array-literal spread ([...a]) and object spread ({...o}) are iterator-based and SAFE — only spread into an argument list hits V8's ~125k-arg limit.

## Governed by

- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — the testing and process-hygiene overview this page details.

## Notes and lessons learned

[^1]: [id: ATOM-5E1F-RAAZ, status: valid, desc: "spool_tap timeouts under load: the one sampled failure was CPU starvation of the collect-lock holder (child inferred, not sampled); count base vs branch serialized behind one lock", keywords: "spool_tap timeout flaky_under_load .collect.lock aldigest_collect starvation rerun_stampede timed_out_waiting_for never_bound_its_ports hold_collect_lock uptime_load1 niced_child_holds_lock", ocd: 2026-11-01, lmd: 2026-11-01] DO NOT rerun spool_tap.rs timeouts on a loaded host in parallel, gated only on load at start, BECAUSE the start-gated reruns stampeded: both started when load1 dipped to about 25 and load1 rose back to about 105 with both reruns AND other unrelated processes running, so the reruns alone are not credited with that rise. The one failure sampled (test t15, one run) was CPU starvation of a lock holder: the t15 test thread blocked in hold_collect_lock on the flock at spool_tap.rs:240 (on <data>/ingest/.collect.lock) while the alcore server held that lock, and the sampled alcore threads were parked (sampled with /usr/bin/sample). Its niced `aldigest collect` child is INFERRED to be starved, not sampled: the STAT RN, 0:11 CPU in 5:32 elapsed reading comes from one ps snapshot, and its sample failed because the process had exited; only the alcore server and the test binary were sampled. On one branch and on the base, the same 8 spool_tap tests failed in the same run; the other timeouts are CONSISTENT with starvation, not shown to be. The runs were launched at lowered priority (niced; one under `taskpolicy -b`, efficiency cores and throttled I/O), so an un-niced CI run may not starve the same way. Each of two branches passed 24/24 once at load1 below 30 (469 s (468.98) and 763 s; max load1 29.69 and 29.76). A single low-load pass shows a branch CAN pass; it is not a discriminator. The discriminator is the failure count for base versus branch, n runs each, serialized under identical conditions, the same counting method as ATOM-FF0B-VOQL above. This is the counter-case to that atom: here load WAS the cause of the sampled failure. A real load-dependent regression (for example a memory-cap throttle) would look the same, so a low-load pass cannot rule one out. DO run the suites serialized behind one mkdir lock, start only when uptime load1 is below about 3x the core count (40 on a 14-core host), and log `uptime` every 30 s during the run. Observation, not a tuned result: tests reported "running for over 60 seconds" 11 times in one run and 10 in the other, at load1 roughly 12-30, so the 300 s start deadline and the 60 s read timeout may be tight on a shared machine. To falsify this: the next time a test blocks at spool_tap.rs:240 under load, sample the `aldigest collect` child with /usr/bin/sample; compute or DuckDB frames mean starved (this lesson holds), psynch_cvwait, flock or read waits mean blocked (this lesson is wrong). Base and branch have not yet been compared under the lock.
