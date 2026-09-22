---
trdd-id: D7MCI7OA
title: review-supervisor runner test fails since the 2026-09-15 gate changes -- possible false no-review-fork nags
column: todo
created: 2026-09-22T23:27:19+0200
updated: 2026-09-22T23:58:02+0200
current-owner: agentlenspro-main-session
created-by: agentlenspro-main-session
task-type: bugfix
min-approval-requirement: none
assignee: agentlenspro-main-session
mandate: true
mandated-by: none
approved: true
approval-judge: agentlenspro-main-session
approval-datetime: 2026-09-22T23:27:19+0200
---

# review-supervisor runner test fails since the 2026-09-15 gate changes -- possible false no-review-fork nags

src/test/reviewSupervisorRunner.test.ts test 'review-supervisor -- real CLI runner (end-to-end)' -> 'OK verdict: a fork after the changes and a registered gate produce exit 0 with EMPTY stdout' fails: its stdout carries a JSON warning containing the phrase 'with NO adversarial review fork after them'. Already failing before any edit this session (first measure run, 20 failures total in the suite). An earlier 'stale bundle' theory is REFUTED: the warning string IS present in the deployed bundle; the earlier grep mismatch was case-sensitive and missed it. Likely cause: the deployed review-supervisor (bundle built 2026-09-15 18:32, containing the TRDD-A37YM37G changes 268f3080..2c32a6ef) or its test broke together with those changes. Possible live effect: false 'no review fork' nags surfacing to users. Next: bisect which of the TRDD-A37YM37G commits (268f3080..2c32a6ef) changed the supervisor's OK-verdict path or the test's fixture, and fix the regression or update the test to match the new (correct) behavior.

## Approval log

- 2026-09-22T23:27:19+0200 — MANDATE issued by agentlenspro-main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Root cause (VERIFIED)

reviewSupervisorRunner.test.ts's forkBlock fixture was `{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }` with no prompt. reviewSupervisor.ts scanSupervision() only credits a fork when declaredRole(prompt) === 'review' (reviewGate.ts:72-76, the owner's 2026-09-15 ROLE: REVIEW marker requirement). declaredRole('') returns null, so the fork was never credited, forks stayed 0, and judge() emitted the warn verdict the test then failed on. NOT an environment/HOME leak: os.homedir() at reviewSupervisor.ts:172 is read but only feeds gateIsRegistered(), which the fixture's own .claude/settings.json already satisfies; the unreviewed count comes solely from parsing the fixture transcript. Confirmed by adding prompt: 'ROLE: REVIEW' to forkBlock: suite goes from 7 failing to 6 failing (the review-supervisor test now passes), with the other 6 pre-existing failures (review-loop D3, 5x standalone-server P5 calibration) unchanged. Title's '2026-09-15 gate changes' dating stands — that IS when reviewGate.ts's ROLE: REVIEW requirement landed; this fixture simply pre-dated it and was never updated.

## Adversarial review disclosure

Fixture fix correct per the 2026-09-15 whole-line ROLE: REVIEW rule (INFERRED from the gate code path; declaredRole not re-read). Remaining: a negative twin test (a fork with no ROLE: REVIEW line -> the supervisor nags). 'No false nags in live sessions' is NOT established -- the supervisor nags any live fork lacking the whole line, by design.
