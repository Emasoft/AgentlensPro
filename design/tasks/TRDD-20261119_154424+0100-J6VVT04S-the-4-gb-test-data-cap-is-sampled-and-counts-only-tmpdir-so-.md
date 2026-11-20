---
trdd-id: J6VVT04S
title: The 4 GB test data cap is sampled and counts only TMPDIR so it is not always enforced
column: todo
status: tasked
created: 2026-11-19T15:44:24+0100
updated: 2026-11-19T23:46:12+0100
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

## Decision 2026-11-19

- 2026-11-19T19:47+0100 — Decided by main-agent (owner: decide yourself), advisor consulted. Nothing is edited before the 2.34.0 tag.
- Gap 1, macOS: the wrapper attaches a per-run 4g APFS sparse image (hdiutil, no sudo) at RUN_DIR, so a write past the cap fails with ENOSPC. Probe 2026-11-19 at 40m: create+attach 1.19 s, dd stopped with ENOSPC at 38 MB, image file 41 MB on the host, a cross-volume rename returns EXDEV. The sampler stays and reports exit 3 when the volume is nearly full, so the cap shows as exit 3 and not as random ENOSPC test failures. hdiutil attach failure exits 2, with no fallback.
- Gap 1, Linux/CI: stays SAMPLED; the hard cap is macOS-only and the card and CLAUDE.md must say so, never 'always' for both. A sudo loop mount in ci.yml is an open option, not decided.
- Gap 1, measure after the tag before keeping it: full-suite time and the latency guard on the image; whether an image can be made at the 10 MiB the trip test uses (only 40m tested); detach while a straggler holds files open; a sweep for images leaked by a killed wrapper.
- Gap 2: grep leads only, not offenders: 24 src/test files with a literal /tmp/ or /var/folders path, 18 with homedir()/HOME, 5 rust-core test files with home_dir/HOME//tmp/. Measure real writes per lead, one file at a time (marker file, then find <HOME,/tmp,/var/folders,repo> -newer marker), then choose count or refuse. Rename-based offenders will fail loudly with EXDEV on the image; plain writers stay silent.
- Gap 3: a project PreToolUse(Bash) hook denies cp, ditto and rsync whose source is over 4194304 KB, naming scripts/capped-copy.sh. du -sk is bounded by a timeout; a source not sized in time is denied with that reason. Limit to state: the hook sees only those commands typed in the Bash command, not copies inside scripts or other tools.
- Gap 1 addendum: the sampler alone cannot turn ENOSPC into exit 3, because a command that hits ENOSPC and exits between two samples ends the poll loop and the wrapper returns the command's own status. So after wait, the wrapper also checks the image volume: nearly full means exit 3, whatever the command returned.
- Gap 2 scope of the counts: the TS grep covered src/test/*.ts only (not scripts/test-*.js or rust-core/tests/fixtures/*.mjs); the Rust grep kept only paths containing test, so #[cfg(test)] modules inside src/*.rs are not in the 5. Rerun both over the full trees when measuring. Gap 2 is NOT decided: count or refuse is chosen after the measurement.
- Gap 3 scope: the hook covers every agent cp/ditto/rsync over 4 GB in this repo, wider than the owner's order (tests, fixtures, measurement data). Chosen on purpose: the incident copy was an agent command, and the hook cannot tell a measurement copy from another one by its path. Owner may narrow it.
- 2026-11-19T22:29+0100 Gap 3 (the copy guard) is built now on the side branch fix/test-cap-copy-guard in the worktree /private/tmp/wt-j6v-copyguard (from 4aee03be); it touches only scripts/, .claude/settings.json, package.json and CLAUDE.md on that branch, the release tree stays frozen, and it is merged only after the 2.34.0 tag. Spec: reports_dev/J6VVT04S/gap3-spec.md, copied onto the branch as design/specs/. The hook is registered with timeout 30 and sizes within 10 s, because Claude Code allows the call if it kills a hook on its timeout. The matrix proves the refusal with a lowered test cap (AGENTLENS_COPY_GUARD_CAP_KB, which can only lower it), never at 4 GiB. Gaps 1 and 2 stay after the tag.
- 2026-11-19T22:37+0100 VERIFIED in the hooks reference (mods-doc-hooks-reference chapter.md:896): a timed-out command hook on PreToolUse does not block the tool call; the call continues through the normal permission flow. Hence the 10 s sizing budget inside the 30 s registration. chapter.md:901 offers onFailure: block (a failed or timed-out hook blocks the action); not used, because this hook runs on every Bash call and a crash would then block all Bash. Owner may choose it.
- 2026-11-19T22:37+0100 known cost of the fail-closed choice: a copy whose source is an unresolved variable (for example the loop variable in 'for f in a b; do cp $f dst; done') or a command substitution is refused, even when small; the agent must write the path literally or use scripts/capped-copy.sh. Possible improvement after measuring how often it fires: resolve 'for NAME in LIST' items and size each. Review the refusal count before the merge.
- 2026-11-19T23:03+0100 Gap 3 committed on the side branch fix/test-cap-copy-guard as dc1cf6a1 (worktree /private/tmp/wt-j6v-copyguard): scripts/deny-oversize-copy.js, its 23-case matrix (23/23 PASS with a lowered cap), registration in .claude/settings.json (timeout 30), check-guards wiring, the spec under design/specs/, and a CLAUDE.md sentence that lists the shapes the hook does NOT see (probe: 12 measured bypass shapes, among them cd before a relative source, eval, brace expansion, wrapper options, if/while/until, cp -t, bash -c). Sibling matrices pass; check-no-identities OK on the branch; UBS 0 critical. Merge after the 2.34.0 tag; the hook is active only after a Claude Code restart. Worker report: reports_dev/J6VVT04S/gap3-worker-report.md.

## Gap 1 notes

2026-11-19T23:46+0100: implementation dispatched on branch fix/test-cap-hard-image (worktree /private/tmp/wt-cap-image), probes held until ISO-DONE. OPEN DECISION before merge: .cargo/config.toml's runner wraps EACH test binary (and every cargo run) in the wrapper, so a bare cargo test or cargo run is an outermost run per binary and would pay one image create+attach each (measured 3.6 s at 10 MiB, 12.5 s at 4 GiB under load ~100). Options: (a) accept, after measuring at low load; (b) document 'scripts/test-data-cap.sh cargo test ...' so every binary joins one outer run; (c) cargo run stays sampled. Decide on the low-load measurement. Merge steps: run src/test/testDataCap.test.ts alone (it now trips a 10 MiB image on macOS), then a full suite before the push. Scope reminder: the image holds only TMPDIR writes; DATA_DIR/HOME/absolute-path writes stay uncounted (Gap 2), Linux stays sampled.
