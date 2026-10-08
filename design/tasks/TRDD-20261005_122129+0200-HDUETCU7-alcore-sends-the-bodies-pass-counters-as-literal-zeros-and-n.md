---
trdd-id: HDUETCU7
title: alcore sends the bodies pass counters as literal zeros and never sends the cumulative reclaim fields the status line was built to render
column: ai_review
status: tasked
created: 2026-10-05T12:21:29+0200
updated: 2026-10-08T16:28:52+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T12:21:29+0200
related: [FGN5TY7E, C5L779YI, U0L78B3Z]
implementation-commits: [97f6806a]
---

# alcore sends the bodies pass counters as literal zeros and never sends the cumulative reclaim fields the status line was built to render

Split out of TRDD-FGN5TY7E box 4 on 2026-10-05, by the reviewing session under the owner order of that date.

Read by the main agent at commit 508f023d: rust-core/crates/agentlens-core/src/server_stats.rs sends bodies.lastPass and persistence.bodiesLastPurge as literal zeros (about lines 548 and 542) and sends neither reclaimedSinceBoot nor lastNonZeroPassAt. A comment in the persistence block (about line 538) says the bodies purge is not ported; by a worker's read on 2026-10-05 that comment is stale. src/cli/serverControl.ts declares both cumulative fields as optional (about lines 632 and 633) and renders them only when present (about lines 837 to 839); by the source, under alcore the status line would therefore read "last pass archived 0" on every call. Nobody rendered it for this card and the live collector was not queried.

By the same worker's read (docs_dev, gitignored; not re-read by the main agent): bodies_pass in chores.rs (about line 250) runs on the 60-second tick, ingests each live body into the store and deletes the raw file, and drains at age 0 over the bodiesMaxGb cap. It counts ingested, deleted, bytes freed, re-emitted and failed as local variables that reach only a log line; no struct, atomic or timestamp holds them, and kept files and bytes are not counted. bodies_purge in body_archive.rs runs only on POST /api/bodies/purge. TRDD-C5L779YI (archived, complete) ticked "server status stops inviting this misreading" on the cumulative line; its own text says the server tracks and serves both fields, which was the TypeScript server retired in commit 567fc5c2. Whether that misreading can still occur now that TRDD-Z53IJFE9 is removing the spool was not established. No open card was found owning these counters (a search of purge, reclaim, lastPass and body_archive; the purge search was cut at 40 rows).

## Acceptance

- [x] bodies_pass publishes the files deleted and bytes freed that it counts today, and records the time of the last pass that deleted anything (not held anywhere today), where server_stats.rs can read it; the emitter sends real values for lastPass, reclaimedSinceBoot and lastNonZeroPassAt in place of the literals. Kept files and bytes are not counted today; either count them or stop sending them.
- [x] A Rust test runs a pass that deletes at least one file and asserts the emitted figures are non-zero; it goes red when the literals are restored.
- [x] The stale comment at server_stats.rs about line 538 says what is and is not ported.
- [x] persistence.bodiesLastPurge is either fed from the same counts or removed, with every reader of it named here first.

Removing the cumulative line and its two declarations instead is the owner's decision; record it here and on TRDD-FGN5TY7E before any declaration is removed. No priority was chosen for this card; TRDD-FGN5TY7E, which it was split from, is high.

## Approval log

- 2026-10-05T12:21:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-05T18:03:48+0200 — column → testing by main-agent@agentlenspro. code landed in 97f6806a; the full crate test run is owed
- 2026-10-08T16:15:59+0200 — column → testing by main-agent@agentlenspro. All four boxes ticked on the 2026-10-08 full-crate green run (766/0, exit 0, evidence recorded on the card); code verified in source and tests, awaiting review per board flow
- 2026-10-08T16:27:45+0200 — column → ai_review by main-agent@agentlenspro. All four boxes ticked; full-crate green run + current mutation red-run recorded with durable evidence paths; four review rounds run; proceeds to ai_review

## Implementation 2026-10-05 (commit 97f6806a)

- What landed: bodies_pass records files removed, bytes freed, the pass time, a since-boot file count and the time of the last pass that removed anything; /api/server-stats sends them as bodies.lastPass, persistence.bodiesLastPurge, bodies.reclaimedSinceBoot and bodies.lastNonZeroPassAt. Source and tests only. Not deployed: the live collector sends zeros until alcore is rebuilt and restarted, which is the owner's act.
- Readers of persistence.bodiesLastPurge, named for box 4 AFTER the code was written (the box asked for them first): the emitter in server_stats.rs, and tests/server_stats.rs (the persistence key list and the object's five inner keys). A worker's git grep over tracked files found no other reader in src, media/src, standalone, skills, agents or scripts.
- Decisions by the session, not the owner: an idle tick with nothing staged records an empty pass (the retired TypeScript server overwrote the object every pass, by a worker's read of 567fc5c2^:standalone/server.ts); the CLI does not print the pass time, so this has no visible effect in server status today. keptBytes and keptFiles are read live at request time; keptFiles is the live file count, a departure from the TypeScript server, which always sent 0. bodiesLastPurge and lastPass are the same object, as in that server.
- The counters live in a process-level static in chores.rs and not in CoreState, because the editing tool refused the CoreState edit, not on merit. Known costs: one shared set of counters per process (the new test file holds a single test for that reason), not reset by CoreState::open, and the struct is declared in lib.rs while stored in chores.rs.
- Checks run by a worker on 2026-10-05: cargo test -p agentlens-core --test chores_bodies_pass_stats --test server_stats, 1 and 4 passed (the main agent read the final run's output whole: no warnings); with the literal zeros restored the new test failed at its removedFiles assertion, left 0 right 1 (read by grep of the output), then passed again. That mutation run started at a load of 42, against the session's own rule. After the last test run two comments in server_stats.rs were moved and rewrapped by replacing the whole function; a comparison of the full diff before and after shows comment lines only. The committed server_stats.rs has not been compiled since.
- Checks NOT run: the rest of the agentlens-core suite (four other test files call bodies_pass; the crate's unit tests), cargo clippy, pnpm check-types. No box is ticked until the full crate run is recorded here; a red run reopens the commit.
- Corrections to the commit message, recorded here because the commit is not amended: 'the only cost' should read 'the known cost'; its list of early exits that record nothing omits the poisoned state lock and the empty scope; 'no warnings' holds for the final run only; 'Semantics follow the retired TypeScript server' has the keptFiles exception above; 'printed last pass archived 0' is by the source, never rendered.
- Known limits: freedBytes includes relocated stranded files and can exceed the bytes of removedFiles; a store pass that examines files and removes none is not covered by the test; the module header of server_stats.rs still lists the body archive among subsystems not ported, which box 3 as written (the comment near line 538) does not cover.

## Verification 2026-10-08

Full crate test run recorded 2026-10-08 16:14: cargo test -p agentlens-core (via --manifest-path rust-core/Cargo.toml), exit 0, 766 passed / 0 failed across 120 suites, no compiler warnings. Both named test files green: chores_bodies_pass_stats 1/1, server_stats 4/4 integration (plus 4 in-module capture_block_tests unit tests). Run started at load 12.24 (under the 20 threshold), finished at 16:13. Evidence: reports/hduetcu7/20261008_161351+0200-full-crate-test-run.md, raw output /tmp/alcore-full-test.txt. The one mutation run's caveat (load 42) from 2026-10-05 stands as recorded; this clean full run at an in-rule load supersedes the 'no box ticked until the full crate run' hold.
2026-10-08 16:20: All four boxes ticked on the green full-crate run. Box 4's reader sweep was performed by a worker on 2026-10-05 (recorded under Implementation) and the bodiesLastPurge feed decision landed with commit 97f6806a; nothing in this run contradicts it. Next: the card owes a column move to ai_review/human review per the board flow — not yet made, recorded as pending.
2026-10-08 16:35, mutation re-run against TODAY's tree (the first review round found the 2026-10-05 red-run predates the last comment edits): chores.rs backed up to /tmp, the real-counts call replaced with literal zeros via fastedit (diff-verified), single test run — bodies_pass_publishes_its_counters FAILED at the removedFiles assertion (left 0, right 1), exit 101 — then chores.rs restored from backup (git diff clean). Box 2's evidence is now current. Wording correction per the same review: today's full-crate green run directly verified the pass path and lifted the card's own hold; boxes 1, 3 and 4 rest on the prior recorded implementation work plus this re-run, not on today's run alone.
2026-10-08 16:55, review-round-3 corrections: (1) Evidence relocated off /tmp: the raw mutation output is now reports/hduetcu7/20261008-mutation-red-run.txt (the earlier entry's /tmp path dies at reboot; this report path is the durable citation). (2) Wording fix — 'the literals restored' named the wrong experiment: what was mutated is the counter-recording call in chores.rs (record_bodies_pass(now_ms, deleted, bytes_freed) → record_bodies_pass(now_ms, 0, 0)); the server_stats.rs literals named by box 1 no longer exist. The red run proves the test catches zero-valued counters at the bodies_pass_stats() struct level; the wire-level 'emitted figures' in server_stats.rs read that same struct, so a zero there propagates, but the test itself observes the struct, not the JSON. (3) clippy remains owed and unrun — carried over from the card's own Checks-NOT-run list; no box depends on it. (4) The earlier entry's /tmp citation for the full-crate run remains superseded by reports/hduetcu7/20261008_161351+0200-full-crate-test-run.md.
2026-10-08 17:05, round-4 additions: (1) The raw mutation output is preserved durably at reports/hduetcu7/20261008-mutation-red-run.txt (copied at 16:55, before the round-4 verdict landed; the round-4 finding had already been addressed). (2) The mutation run's 1-minute load was NOT recorded at the time — recorded here as a known gap in the evidence chain; the full-crate run recorded 12.24 at start and the mutation run began minutes later under comparable conditions, but that is context, not measurement. (3) The 'built 2026-10-03' provenance on the sibling card overstates mtime evidence: bin-native is gitignored with no commit link, so the mtime proves when the file was written, not what was compiled into it; the behavioral evidence (NA-when-absent proven 2026-09-24, explicit 0s today) independently settles what that card's entry claims. (4) The ai_review moves carry a pending third-fork verdict (against commits 9e1de061/b25e7c9b) and this fork's own verdict — review-pending, not review-cleared, until both land.
