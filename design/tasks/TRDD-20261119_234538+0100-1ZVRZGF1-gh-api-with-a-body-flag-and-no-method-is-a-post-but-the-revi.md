---
trdd-id: 1ZVRZGF1
title: gh api with a body flag and no method is a POST but the review-gate scanner classes it as a read
column: todo
status: tasked
created: 2026-11-19T23:45:38+0100
updated: 2026-11-20T00:19:51+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:45:38+0100
---

# gh api with a body flag and no method is a POST but the review-gate scanner classes it as a read

Found by the BQC0IA74 triage (reports_dev/review-gate-issues/20261119-triage.md): ghApiIsMutating (src/cli/reviewGateTriggers.ts:329-340) returns false when no -X/--method is given, but gh api --help says the default method becomes POST when a parameter is added (-f, -F, --field, --raw-field, --input). So 'gh api repos/o/r/issues -f title=x' is a write the scanner misses (fail-open; reaches the mod through verdict.work). Fix: no explicit method plus a body flag (attached forms too) = mutating; an explicit GET stays a read; 'gh api graphql' is mutating only when the query holds 'mutation'. Add the cases to the triggers tests. Origin INFERRED (the method-based rule answered GitHub 23), git blame not read.

## Approval log

- 2026-11-19T23:45:38+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20T00:11+0100 quoted mid-value expansion residual split to TRDD-6OM9SMLC; unquoted $(...) and backtick cut (option a) sent to the worker, report reports_dev/1ZVRZGF1/20261120-fix-r3.md when it returns.
2026-11-20T00:13+0100 main agent read shellWords (worktree lines 46-71), stripHeredocBodies (105+) and commandWriteReasons (513-545) whole: shellWords turns an unquoted ( and a backtick into a ; separator, so query=$(cat q) reaches the gh segment as the word query=$ and query=`cat q` as query=; stripHeredocBodies acts only on <<; the segment loop drops only REDIRECT_WORD_RE words (^\d*(>|>>|<{1,3})), which query=$ and query= do not match. So the two unquoted rows should return gh api (mutating) by code reading; a test run after the gate decides.
2026-11-20T00:19+0100 corrections: (1) the previous line misquoted REDIRECT_WORD_RE; the source is /^\d*(?:>\||>>?|<{1,3})/ (the >| clobber form included); the conclusion stands. (2) main agent read the post-edit ghApiIsMutating (worktree lines 350-365) and test rows 133-137: condition v.startsWith('@') || v === '' || v.endsWith('$') || /^\$\{?\w+\}?$|^\$\(|`/; the WHY comment cites TRDD-6OM9SMLC (no TRDD-8S104SPF left in the worktree, worker grep). reports_dev/1ZVRZGF1/20261120-fix-r3.md still names TRDD-8S104SPF in two places: superseded by this line.
