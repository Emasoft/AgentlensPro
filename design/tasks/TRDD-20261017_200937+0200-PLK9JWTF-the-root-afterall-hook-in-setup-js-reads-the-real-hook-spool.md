---
trdd-id: PLK9JWTF
title: The root afterAll hook in setup.js reads the real hook-spool and can exceed its timeout on long runs
column: backburner
status: tasked
created: 2026-10-17T20:09:37+0200
updated: 2026-10-17T20:18:32+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T20:09:37+0200
---

# The root afterAll hook in setup.js reads the real hook-spool and can exceed its timeout on long runs

## Symptom

After an 11-minute run of src/test/floodBenchRate.test.ts (FLOOD_RATE_SECONDS=300, isolated mocha command with --timeout 10000), both cases passed but mocha exited 1: `"after all" hook: afterAll in "{root}"`, Timeout of 10000ms exceeded. The 1-minute load was 76-127 at the end of the run.

## The hook

The hook is src/test/setup.js mochaHooks.afterAll (around lines 365-400). It has no this.timeout of its own. It reads the REAL ~/.agentlens/hook-spool (REAL_HOME from AGENTLENS_TEST_REAL_HOME, HOME or os.homedir(), captured at require time). A test-suite hook reading the live data dir is an isolation concern in its own right.

## Cause

UNMEASURED. The standing 20,000-file cap assumed in the setup.js:269 comment was not observed when measured (the spool was far smaller), so that comment is not a reliable account of the cause. Candidates: the execFileSync ps survivor polls under load, rmSync of TEST_ROOT, and the spool reads.

## Next step

Time each phase of the hook, then give it its own timeout.

## Evidence

TRDD-C19SUVPH ## Evidence, the 2026-10-17 Box 2 note (the run); src/test/setup.js mochaHooks.afterAll; src/test/floodBenchRate.test.ts (the run recipe: FLOOD_RATE_SECONDS=300). Gitignored detail: reports_dev/c19/20261017_183811+0200-deadline-fix-measure.md section 4 (gitignored), and docs_dev/20261017-c19-part2-mutations-report.md F2.

related: [C19SUVPH].

## Approval log

- 2026-10-17T20:09:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
