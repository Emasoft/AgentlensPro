---
name: test-port-race-and-mocha-isolation
description: "a free-port probe is flaky in CI but passes on rerun / port already in use in CI but passes on rerun / flaky test only on one matrix leg / freePort race between probe and listen / retry swallowed a real startup failure / match the port text not exit code 1 / mocha does not isolate a single test file / npx mocha single file still runs the whole suite / --spec does not isolate / only --grep narrows / .mocharc spec glob adds to the file / test passes in isolation claim / EADDRINUSE already in use / spawnServerWithRetry / in-process claimed set for ports / verify the passing count"
ocd: 2026-08-12
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# Test free-port races and mocha isolation

^ATOM-OL89-HIFU [desc:"freePort is a TOCTOU claim; two mitigations are needed, the retry must match the PORT TEXT not a bare exit(1), and npx mocha <file> does not isolate because .mocharc adds a spec glob", keywords: port_already_in_use_in_CI_but_passes_on_rerun flaky_test_only_on_one_matrix_leg freePort_race_between_probe_and_listen retry_swallowed_a_real_startup_failure npx_mocha_single_file_still_runs_whole_suite mocharc_spec_glob_does_not_isolate, type: project, ocd: 2026-08-12, lmd: 2026-09-23]

**A "free port" probe is a TOCTOU claim with a very short shelf life.** The classic helper —
`listen(0)` → read the port → `close()` → resolve — proves the port was free AT PROBE TIME only.
Between that close and the child's own `listen()`, the OS may hand the same ephemeral port to
anything, including another test's server in the same run. Retrying the ASSERTION cannot help: the
child already exited. Diagnosed from CI run 31139375893, where `build-and-test (20)` died on
`Port 33097 (OTLP) already in use` while `(22)` passed **at the identical commit** — a leg passing
is what distinguishes a race from a regression.

^ATOM-JNJY-FQWS [desc: "Free-port flakiness needs an in-process claimed-set AND a bounded fresh-port retry; match PORT TEXT not a bare exit(1)", keywords: port_probe_two_mitigations_needed in_process_claimed_set bounded_retry_on_fresh_port disjoint_port_ranges_still_collide retry_matcher_swallows_startup_failure match_port_text_not_exit_code EADDRINUSE_already_in_use serverSingleInstance_test_exit1 retry_hid_the_real_reason spawnServerWithRetry, type: project, ocd: 2026-09-23, lmd: 2026-09-23]

Two mitigations, because neither alone closes the window: an in-process claimed-set (the only
collision source we can see — mocha runs the whole suite in ONE process) and a bounded spawn-retry
on a FRESH port (a claimant outside this process). Do NOT "fix" it with disjoint per-file port
ranges: that trades a rare race for a permanent collision, and CI runners are not exclusive.

**The retry matcher is where this gets dangerous, and it is subtle.** Matching a bare
`exited early (code=1)` makes EVERY exit(1) retryable — so a genuine startup failure burns three
attempts and is then reported as port contention, with the real reason buried. Match the PORT TEXT
only: both the server's own message and Node's raw `EADDRINUSE` contain "already in use", so no
real port case is lost. This is not hypothetical — `serverSingleInstance.test.ts` asserts a
DELIBERATE exit(1) ("Refusing to start") that such a retry would swallow, and it is one
`spawnServerWithRetry` call away from being wrapped.

**The mocha-isolation trap that bites while verifying this is its own atom — see ATOM-TEPQ-RXBX.**

^ATOM-TEPQ-RXBX [desc:"npx mocha <file> AND --spec both run the full suite here; only --grep narrows, so verify the passing COUNT", keywords: mocha_isolate_single_file run_one_test_file npx_mocha_file_runs_whole_suite --spec_does_not_isolate --grep_narrows_mocha test_passes_in_isolation mocharc_spec_glob, ocd: 2026-08-12, lmd: 2026-08-12]

**No mocha flag isolates a single test FILE in this repo — only `--grep` narrows, and you must
verify the COUNT.** `.mocharc` sets `spec: ['out/test/test/**/*.test.js']`, and a positional
filename is ADDED to that glob rather than replacing it, so `npx mocha <file>` silently runs the
whole suite. Measured 2026-08-12: `--spec out/test/test/serverLogTailScope.test.js` ran all 2239
tests too — identical to the positional form — while `--grep "scoped to THIS attempt"` ran 5 tests
in 21 ms.

**An earlier version of this lesson recommended `--spec` as the remedy.** That is worse than having
no lesson: the reader believes they isolated a file, sees green, and concludes "it passes in
isolation" — the exact false conclusion the lesson exists to prevent, now carrying the authority of
a documented fix. So the durable instruction is not a flag at all: read the `N passing` line and
check it against how many tests that file defines. A count is evidence; a flag is a hope.

Practical consequence: a full-suite run is ~1 min here, so "isolation" is rarely worth chasing. Use
`--grep` when you genuinely need one test (falsification runs, where an unrelated red would muddy
the result), and otherwise just run the suite and read the delta against the known baseline.

## Governed by

- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — the testing and process-hygiene overview this page details.

## Notes and lessons learned
