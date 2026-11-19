---
trdd-id: J6VVT04S
title: The 4 GB test data cap is sampled and counts only TMPDIR so it is not always enforced
column: todo
status: tasked
created: 2026-11-19T15:44:24+0100
updated: 2026-11-19T15:44:48+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T15:44:24+0100
---

# The 4 GB test data cap is sampled and counts only TMPDIR so it is not always enforced

## Approval log

- 2026-11-19T15:44:24+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## User order (verbatim)

- 2026-11-16: "add a permanent cap to tests to limit to 4 GB any generated fake data for tests!" and "no, the cap is 4GB. i don't care about testing full data size."
- Session goal: "verify the cap on the tests at 4GB is always enforced. then complete the TRDDs"

## Problem

- Verified answer to the goal, 2026-11-19: the cap is NOT always enforced. Every launch path is wrapped (pnpm test:unit and test:browser, the mocha self-wrap in src/test/setup.js, the cargo runner in the repo-root .cargo/config.toml, the CI browser-smoke step; pnpm run check-test-cap guards the wiring), but three gaps remain, all recorded in CLAUDE.md:
- Gap 1, sampling: scripts/test-data-cap.sh measures every 5 s, so a fast writer can pass 4 GiB between two samples.
- Gap 2, scope: only files under TMPDIR/TMP/TEMP are counted; a test writing to its own DATA_DIR or HOME outside TMPDIR, or to a hardcoded absolute path, is not counted.
- Gap 3, ad-hoc copies: the 26 measurement scripts copy through scripts/capped-copy.sh (TRDD-569BMAGD), but a copy command typed by an agent outside those scripts is unchecked.

## Candidate design (NOT decided)

- Gap 1: run the test TMPDIR on a 4 GB sized disk image (hdiutil create -size 4g, attached without sudo), so a write past the cap fails with ENOSPC instead of waiting for a sample. Unmeasured: attach time, APFS image overhead, CI (Linux) equivalent.
- Gap 2: a check that every test HOME and DATA_DIR resolves under TMPDIR, or the wrapper counting those roots too.
- Gap 3: a PreToolUse(Bash) hook in this project that denies cp, ditto and rsync whose source is over 4194304 KB (du -sk), naming capped-copy.sh as the way.

## Acceptance

- [ ] A test proves a writer under TMPDIR cannot leave more than 4 GiB on disk, however fast it writes; it fails on the current sampled wrapper.
- [ ] A test proves a test writing outside TMPDIR (its own DATA_DIR or HOME) is counted or refused; it fails today.
- [ ] A hook test proves an agent Bash copy of a source over 4 GB in this repo is denied; it fails today.
- [ ] The "Still NOT covered" list in CLAUDE.md matches what remains after the fix.

## Constraint

- Not before the 2.34.0 tag (TRDD-HSPUF5XH): any edit to scripts/test-data-cap.sh, the .cargo/config.toml runner or src/test/setup.js voids every test gate and the full-suite pair of that release.
