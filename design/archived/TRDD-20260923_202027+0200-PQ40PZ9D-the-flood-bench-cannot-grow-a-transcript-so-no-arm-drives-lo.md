---
trdd-id: PQ40PZ9D
title: The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds
column: complete
created: 2026-09-23T20:20:27+0200
updated: 2026-11-16T22:50:33+0100
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:20:27+0200
status: archived
implementation-commits: [df44e8de, 0f3b2ed7, 3f583f6d, 7339f295, ec496a73, 8173625f]
---

# The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-17

- The box-2 gap (an ancestor symlink let the bootstrap write 16 files before the post-mkdir check refused) is FIXED in commits 3f583f6d and 7339f295 (0f3b2ed7 is the WIP helper checkpoint before them). Box 2 is re-ticked; see ## Guard fix (2026-10-17).
- Evidence for the fix: the scratch-proxy cases. a and b are refused with nothing written and go red under the mutations; c proves the guard does not over-refuse; d and q are refusals the old code did not make. Mutation results (M1: a and d fail; M2: b and c fail; M3: stays green) are from the worker's run; the orchestrator re-ran only the green suite. Real-home refusal is shown by exit codes and messages through the same protectedHit over the same roots list; write ordering for the real home rests on reasoning plus the proxy cases and was NOT measured on the real home. Counts: 14 refusals on darwin (a, b, d, e, g, q, i, j, k, l, m, n, o, p), 13 on Linux (e skipped), 3 accepted (c, f, h); 17/17 on darwin, 16 plus 1 SKIP on Linux.
- Wiring: ec496a73 adds scripts/test-flood-transcripts-guard.js to check-guards (local run exit 0, 17/17) and as its own ci.yml step; not yet observed on CI (no push). Case n made platform-aware in 8173625f: with no ~/.claude (usual on CI) the link dangles and the guard refuses it as dangling; that branch is first exercised on CI. Do not push before reviewing. Known red-not-false layouts, recorded not fixed: ~/.claude as a dangling symlink (case j), TMPDIR under the home, a home of /.
- NEXT ACTION: owner review in human_review (moved 2026-10-17 by main-agent@agentlenspro). Open follow-ups, not blockers: the test asserts the bench's exact refusal text; freePorts can hang if the second listen fails.

EQCGAVGV's arms need a log-growth driver: put_log_session (rust-core/crates/agentlens-core/src/lib.rs:292) bumps data_version whenever the log sweeper updates a session card, so transcript growth drives summary rebuilds, and no current flood-bench mode grows a transcript.

Add a mode to scripts/bench/alcore-ingest-flood.mjs that appends synthetic Claude Code JSONL (assistant turns carrying usage) to <isolated HOME>/.claude/projects/<slug>/<session>.jsonl at a configurable lines/s, refusing the passwd user's real ~/.claude (os.userInfo().homedir).

Acceptance: [x] the isolated instance's summary misses and session-card count rise with the appended lines (live run 2026-10-08: summaryMissesDelta=8, logSessionsDelta=15, dataVersionDelta=128, exit 0, append rate 24.999/s vs target 25); [x] refuses the real home (subtree guard: real home, its .claude, any descendant, '/', plus a post-mkdir symlink re-resolve; verified 2026-10-17 by scripts/test-flood-transcripts-guard.js, 17/17 on darwin, 16 plus 1 SKIP on Linux where case e is skipped: 14 refusals on darwin (a, b, d, e, g, q, i, j, k, l, m, n, o, p), 13 on Linux, and 3 accepted (c, f, h). The evidence is the scratch-proxy cases: a and b are refused with nothing written and go red under the mutations (per the worker's mutation run; the orchestrator re-ran only the green suite), c proves the guard does not over-refuse, d and q are refusals the old code did not make. Real-home refusal is shown by exit codes and messages through the same protectedHit over the same roots list; write ordering for the real home rests on reasoning plus the proxy cases and was NOT measured on the real home; commits 3f583f6d, 7339f295); [x] the line shape is parsed by agentlens-logscan's Claude parser (cited in source: agentlens-logscan/src/lib.rs:842 assistant branch, :851 usage dedup per message.id, :762 cwd, :1279 file-stem session id, disjoint_anthropic :147, spanstore parse_iso_ms :165). related: [EQCGAVGV, C19SUVPH].
- 2026-11-16 23:0x REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): ACCEPTED. Re-checked today: all six implementation commits are ancestors of HEAD; node scripts/test-flood-transcripts-guard.js exit 0, 17/17 on darwin; the test is named in package.json and ci.yml. Not re-checked: the mutation runs, the Linux leg, CI (nothing pushed). The two open follow-ups (exact refusal text in the test, freePorts hang) stay recorded as non-blockers.

## Approval log

- 2026-09-23T20:20:27+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-08T17:40:51+0200 — column → dev by main-agent@agentlenspro.
- 2026-10-08T18:33:11+0200 — column → testing by main-agent@agentlenspro.
- 2026-10-08T18:40:05+0200 — column → human_review by main-agent@agentlenspro.
- 2026-10-17 — box 2 unticked by main-agent@agentlenspro: a read-only re-verification (reports_dev/pq40/20261017-verify-report.md, gitignored) showed --transcripts-home under an ANCESTOR symlink into another tree passes the pre-write guard (path.resolve does not follow it) and the bootstrap writes 16 files before the post-mkdir check refuses; proven on a scratch proxy, the real home was not touched. Box 2 is re-ticked only after the fix is verified by a seam test that shows exit 2 with zero files under the protected root, and a reverted-fix mutation that creates files.
- 2026-10-17T12:24:23+0200 — column → dev by main-agent@agentlenspro. box 2 gap found 2026-10-17; guard fix in progress
- 2026-10-17 — box 2 re-ticked by main-agent@agentlenspro on test 17/17 + mutations M1/M2 red (commits 3f583f6d, 7339f295); round-1 guard design rejected in review, round-2 accepted.
- 2026-10-17T14:27:31+0200 — column → testing by main-agent@agentlenspro. guard fix 3f583f6d+7339f295, test 17/17, mutations M1/M2 red
- 2026-10-17T14:27:35+0200 — column → human_review by main-agent@agentlenspro. check-guards green incl. new test (wiring commit); CI not yet observed
- 2026-11-16T22:50:33+0100 — COMPLETE by main-agent@agentlenspro. reviewed in the owner's stead per the 2026-11-16 order; guard test 17/17 re-run today, commits are ancestors of HEAD.

## Implemented (2026-10-08)

--mix transcripts landed in scripts/bench/alcore-ingest-flood.mjs (173 insertions, 10 deletions, uncommitted). --lines-per-sec is the TOTAL append rate, routed through the existing --rate pacing machinery (no third pacing loop); the transcripts branch replaces the http post with fs.appendFileSync. Refusal guard is subtree-based (real home, its .claude, any descendant, '/') with a post-mkdir symlink re-resolve ceiling. Live run against an isolated alcore (copied+codesigned binary, own HOME/DATA_DIR/ports 3907/4407/3997): exit 0, 1125 appends at 24.999/s (target 25), logSessionsDelta=15, summaryMissesDelta=8, dataVersionDelta=128, 0 bad. Known mechanisms recorded per review: fetchSnapshot GETs /api/summary in transcripts mode (the reader that makes summaryMissesDelta meaningful — without it the delta is structurally 0); fs append failures are NOT a server-down signal but still feed the 20-fail/30s early-stop as a wedged-fs guard; underRate/reqPerSec/ok2xx mean appends in this mode. Ops note: SIGTERM did not stop the test alcore within 2s; SIGKILL was needed (uninvestigated, ops-lessons candidate). Full report: docs_dev/20261008_182830+0200-PQ40PZ9D-impl-report.md (gitignored).

## Review round 3 (2026-10-08)

The work-review fork's findings, dispositioned: (1) id-counter scope CONFIRMED PER-WORKER — transcriptLineNo is declared inside worker() (line 519), and an all-1126-lines scan found 1126 distinct ids, zero dups; the single-sampled-file gap is closed. (2) 'Parser accepts with silently defaulted fields' ceiling NAMED: all 16 bench cards share one synthetic cwd/workspace (single-project slug) — a fidelity ceiling a real fleet would not have; acceptable for a churn/heap bench, recorded here as the ceiling. (3) refusal-error message says 'the real home (or its .claude)' for every branch including '/' — cosmetic, left. (4) SIGTERM-insufficient-against-test-alcore is now a THREE-occurrence pattern (pids 32797/50556 orphans, this run's 43823) — filed as its own card, not a note. (5) Column: this card's live run WAS the test; testing → human_review is the honest hop (the substantive code pass happened in two adversarial spec rounds + the parent's diff read).

## Review round 4 (2026-10-08)

Round-4 fork: the id-uniqueness closure was over-claimed as scan-proven. CORRECTED: uniqueness is guaranteed STRUCTURALLY by the msg_w${i} worker-index prefix in the id (each worker's counter is its own), with the 1126-distinct-ids zero-dup scan across all 16 files as corroboration only. No further action.

## Guard fix (2026-10-17)

Root cause: ensureTranscriptFile writes via path.join, which collapses '..' by text. The old pre-write check (realpathOrResolve, falling back to path.resolve) did not follow an ancestor symlink, so --transcripts-home LINK/zz wrote 16 files before the post-mkdir check refused.
Round-1 design, REJECTED in review: apply '..' after following a symlink. It judged a path the writer never uses (the writer collapses '..' textually first), and it let HOME/linkToScratch/../x through.
Round-2 design, ACCEPTED: normalize once with path.resolve; walk the components, following each existing symlink; refuse before any write; the post-mkdir ceiling is the kernel realpath of the created bench-transcripts dir. Two test seams can only ADD protection: --guard-only, and the env var BENCH_TEST_EXTRA_PROTECTED_ROOT.
Test: scripts/test-flood-transcripts-guard.js, 17 cases: 17/17 on darwin, 16 plus 1 SKIP on Linux (case e is darwin-only). 14 refusals on darwin (a, b, d, e, g, q, i, j, k, l, m, n, o, p), 13 on Linux, and 3 accepted (c, f, h). Scratch-proxy end-to-end cases: a, b, c, d, e, f (accepted positive control: 16 files written, ECONNREFUSED), g, q; a and b are refused with nothing written, c proves the guard does not over-refuse, d and q are refusals the old code did not make. --guard-only real-home cases: h (accepted), i, j, k, l, m, n, o, plus p (argument error); these show real-home refusal by exit codes and messages through the same protectedHit over the same roots list, and are regression checks (the old code refuses them too). Write ordering for the real home rests on reasoning plus the proxy cases; it was NOT measured on the real home. Mutation results below are from the worker's run; the orchestrator re-ran only the green suite.

| mutation | change | result |
|---|---|---|
| M1 | pre-write check back to realpathOrResolve | cases a and d fail |
| M2 | round-1 helper, no path.resolve | cases b and c fail |
| M3 | drop the darwin lowercasing | stays green, so the lowercasing is documented as defensive and unproven |

Commits: 0f3b2ed7 (WIP helper checkpoint), 3f583f6d (the fix plus the new scripts/test-flood-transcripts-guard.js), 7339f295 (review follow-ups: protected root pinned by name, freePorts race, empty extra root refused, darwin comment). Wiring: ec496a73 (check-guards + ci.yml), 8173625f (case n platform-aware).



## Acceptance

- [x] the isolated instance's summary misses and session-card count rise with the appended lines (live run 2026-10-08: summaryMissesDelta=8, logSessionsDelta=15, dataVersionDelta=128)
- [x] refuses the real home (scripts/test-flood-transcripts-guard.js, 17/17 on darwin, re-run 2026-11-16; commits 3f583f6d, 7339f295)
- [x] the line shape is parsed by agentlens-logscan's Claude parser (cited in source in the body paragraph above the Approval log)
(This bulleted list restates the three inline boxes of the body paragraph, added 2026-11-16 only so the archive gate can count them; no criterion was added or dropped.)
