---
trdd-id: AVUGZV1K
title: Owner directive 2026-10-04 complete all TRDDs - per-card triage then work in waves
column: dev
status: tasked
created: 2026-10-04T12:48:47+0200
updated: 2026-10-05T02:17:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: audit
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-04T12:48:47+0200
---

# Owner directive 2026-10-04 complete all TRDDs - per-card triage then work in waves

Owner directive, quoted verbatim: "complete all TRDDs!" (2026-10-04, mid-session).

Method: seven read-only triage workers classify every open card (A-CLOSE done and verified, B-SMALL, C-LARGE, D-OWNER, E-OBSOLETE, F-UNCLEAR). Reports go in gitignored docs_dev; 20261004-board-triage-spec.md is the spec. No card is moved to complete on a worker word: the main agent verifies each A-CLOSE itself or through a second independent worker, never on INFERRED evidence.

Work order: owed fixes first, then verified closes one at a time, then B-SMALL ranked by what it unblocks with one writer per file set, then C-LARGE. D-OWNER cards are listed for the owner with the blocker named.

Never under this directive without the owner: deploy or restart of the live collector, copying into bin-native, node esbuild.js on the installed bundle, push, tag, publish, settings edits, anything against the real data directory, deleting uncommitted work, freeing disk outside /tmp.

Board at start: todo 53, human_review 32, backburner 32, dev 22, testing 11, blocked 9, planned 4, ai_review 3, design 2, proposal 1 (169 open). LOCAL-scope cards under .claude/local/design were not listed in the first triage and still need it.

## Approval log

- 2026-10-04T12:48:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Cards that need the owner, grouped by the act that unblocks them (first triage 2026-10-04, unverified leads)

- deploy (rebuild alcore, codesign, copy into bin-native, restart the collector): 12 cards. TOIM26HP live RSS delta; 5JZQFVO8 real-corpus boot, deploy awaits word; ORGJ0E3G backfill never armed live; X70L1O3S fix runs only after rebuild; 7RM5YW2T live cpu/rss target missed; MBQ9LXAN per-frame live measurement; GR6WHHK5 merged, not deployed; 9SOYXKNE live OTLP count needs rebuild; 563B8WYH live outage, fix in 2JOIAH2G; 9SYRK6SW restart-and-verify parquet unrun; RVKQDLRD deploy, then verify flaky shutdown test; Z53IJFE9 live acceptance, then worktree removal.
- rebuild the installed CLI bundle (node esbuild.js) and restart: 3 cards. LZ2JDIJP review gate effective after build; E9RM51XG stale bundle remedy; YGETIBJS deploy step, first wait for 40M4UPK3 and BA0DCW98.
- git push and CI green: 2 cards. EJDNNDY3 CI sets alcore, five boxes unticked; QJPUG1WP only the CI rust job owed.
- npm publish / release (tag push): 2 cards. HSPUF5XH release gate, 15 open blockers first; IXMB2JVD box 1 post-release.
- a measurement on the live collector or the real data directory: 10 cards. CEAZZHHO 24 h of session ids; 21QXUL1P 24 h bodies-dir sampler; DX8PYPLO re-measure gated on 2JOIAH2G R0b; 2R36W8Q1 re-measure boxes 2, 3, 5; 768NEX6E vmmap on the live pid; 3EZ6SJ2Z one real fork launch; BFUZ1THR captured statusline row needed; V8W9A8FZ one measured advisory; VRW14OB0 first-fork-after-cold pair; IPEPUEL5 credits-regime capture needed.
- a named decision by the owner: 16 cards. WKLD508O the 2 GB cap decision; EGGERLEO strict decimal port parsing; DIZ289UQ accept TTL-tier substitution; XTFDRTH2 accept on boxes 1-2; BLAV6W15 accept one-path expansion deviation; 0E3W5C45 amend rule, rule on marker trade; 7FA3NIXU change or keep 4 MB anchor; VW0V6QLK rewrite OS login on 21 cards; ZSX34J8F cargo retention rule; IXVHM52P close or re-park; LHCHVK9Z wrong-typed policy, NOT NULL, switch-on; 0D6QK5CW go/no on 81BW1CS9, then deploy; 2JOIAH2G step-0 and queue answer, then deploy; M2VK8T4P approve deploy-path signing change; E32TO0XC pull the card forward; HH1NP0KD go-ahead on spool hook path, then hook change.
- approval of a proposal: 1 card. I5O38KKP add pricing check step to ci.yml and publish.yml.
- settings or hook registration change: 1 card. X8MW8K92 install hook, unregister standalone gate, live fork probe.
- other: 2 cards. N60JUWU3 test-hook design for 120 s mutex hold, then deploy; 4FLTDMHA leak process gone, kill-on-Drop guard possible.
2026-10-04 correction: the grouping above was a shallow first triage. A second read of the deploy and decision groups (reports in gitignored docs_dev) found: deploy-only alcore X70L1O3S 9SOYXKNE ORGJ0E3G MBQ9LXAN; deploy-only CLI bundle LZ2JDIJP; probably already live, live check only GR6WHHK5 9SYRK6SW; code first 5JZQFVO8 7RM5YW2T YGETIBJS E9RM51XG N60JUWU3; decision first 563B8WYH Z53IJFE9; stale TOIM26HP. Of the 15 decision cards only VW0V6QLK and E32TO0XC are the owner's; EGGERLEO BLAV6W15 ZSX34J8F 0D6QK5CW 2JOIAH2G M2VK8T4P HH1NP0KD are decidable from tests or measurement; WKLD508O DIZ289UQ XTFDRTH2 0E3W5C45 IXVHM52P are sign-offs on finished boxes (IXVHM52P box 1 stops the live server: owner); 7FA3NIXU is stale. RVKQDLRD carries another session's uncommitted edits and must not be touched or staged.

## Closes made under the directive

2026-10-04: complete YE15B2JK DCWJY2JJ MF4YQWWA KBK9J59Y U0L78B3Z X4YTS5BF 4TOU4V8E P08Q5TK1 Z0YKJ67N JGM1JKN0 OHZGLDNG; superseded 5PUD8RKE ZW4APOPI GG0WOHEV; publish 0Y8BMVK2. MF4YQWWA was closed before its regeneration claim was true; commit 20bdbd3e made it true (the burnscan generator runs again and regenerating changes no fixture). P08Q5TK1 rests on a source read only, with no test. The tool refuses writes to archived cards, so both notes are recorded here.
2026-10-04 (second run): complete ME89GHUA YVQI5DYD YVJYOJ81 Z228SAC7 BZFYC809 DGLBZRBR 8ADTIGKT V79W9T2R YBJGIYI1; superseded Z8B5BDB5 (by YVQI5DYD). Left open with notes: VDQ2N8PX FGN5TY7E 4EV3OJ19 AHM7OUG1 PNB9FNJ0 BA0DCW98 J2K6IM4R 2CYTNLY1 8YM21R5X 2C23ROPZ.
2026-10-04 caution: seven closes (ME89GHUA YVQI5DYD YVJYOJ81 Z228SAC7 BZFYC809 DGLBZRBR V79W9T2R) were made on a one-line acceptance list written by the closing worker to satisfy the tool, not by an independent verifier. Checked afterwards by the main agent: the tests behind ME89GHUA, YVQI5DYD, Z228SAC7, BZFYC809, DGLBZRBR passed in its own runs; V79W9T2R's mutation was run by a later worker and its test file needed a serialization fix; YVJYOJ81 (changelog entries) was never compared with the commit list.

## Owner order 2026-10-05 - reviews delegated

- Owner order, quoted verbatim (2026-10-05, mid-session): "decide yourself. base your decisions on verified facts and tests. you are in charge, complete all TRDDs reviews in my stead."
- Reading of the order (the agent's, not the owner's words): it covers review acts, meaning the 20 cards in human_review on 2026-10-05 and the sign-offs this card lists as owner decisions on finished boxes, and decisions that a fact or a test can settle. It lifts none of the acts this card reserves to the owner: deploy or restart of the live collector, copying into bin-native, node esbuild.js on the installed bundle, push, tag, publish, settings edits, anything against the real data directory. VW0V6QLK and E32TO0XC stay the owner's.
- Method: one reviewer at a time follows docs_dev/20261005-human-review-spec-v2.md (gitignored scratch; this card is the record). The reviewer runs the card's tests narrowly and does one undo-verified mutation. No card moves on a reviewer's word: the main agent re-runs the reported test commands and re-reads the cited lines itself first.
- Verdict to column: ACCEPT moves to complete. ACCEPT-PENDING-DEPLOY moves to deploy (code reviewed, only a live check or deploy remains). RETURN-TO-DEV and NEEDS-TEST move to todo with the owed fixes appended, never to dev, because dev claims someone is working. STALE or SUPERSEDED moves to superseded with superseded-by set.
- Batch bounds: at most 19 reviewers, strictly serial, about 130k subagent tokens each as measured on the pilot (ZIWEB0UW: 130,443 tokens, 49 s). Stop the batch if a reviewer leaves the working tree changed, or after two consecutive reviewers fail to finish.
- Order of work changed on 2026-10-05: human_review first, because the newest order names reviews; the 36 cards in dev, testing and ai_review (they claim work nobody is doing) come next under the 2026-10-04 order.
- LHCHVK9Z is not sent to a reviewer: it already carries three confirmed unfixed defects (its section Review findings 2026-10-04), so its verdict is RETURN-TO-DEV.
- Carried over from 2026-10-04 and not yet acted on: acceptance sign-offs on WKLD508O, DIZ289UQ, XTFDRTH2, 0E3W5C45; stale cards 7FA3NIXU and TOIM26HP; the blocker on 0D6QK5CW; the deploy checklist for the deploy-only cards; the D-D amendment on LHCHVK9Z; the serial re-run of the tap rejection tests and the t23 mutation check for d8de334d; a STATE block for ZSX34J8F; a guard so scripts/cargo-target-retention.sh refuses --apply until its rule is corrected; the session handoff of 2026-10-04 was never found or read.
- Found on 2026-10-05, belongs to the janitor plugin and not to this repo: its token keepalive skips the stored slot of whichever account is live, so that slot lapses (it had no time left on 2026-10-04 until a manual capture). Not filed anywhere yet.
- Amendments after a second review of the method (2026-10-05). A test run counts only when its output shows the named test passing and at least one test run; a test that exists for an item and was not run leaves that item UNTESTED. The mutation edits one line of a file that had no uncommitted change, is undone at once, and the main agent compares a checksum of `git diff` before each reviewer starts and after it returns, and launches no further reviewer while the two differ.
- A card whose central claim (what its title asserts) can only be shown on the deployed collector gets the verdict CORE-CLAIM-LIVE-ONLY. It moves to deploy like ACCEPT-PENDING-DEPLOY, and the first line of its review section must say the central claim is unmeasured and name the measurement to run after deploy. ACCEPT-PENDING-DEPLOY requires the central claim itself to be verified by a test here.
- Why `deploy` and not `complete` for those cards: trddgrep accepted the move human_review to deploy for ZIWEB0UW on 2026-10-05, and deploy is the column that says code is reviewed and a deploy is awaited. The second review argued deploy should follow complete; rejected, because complete would claim an acceptance item that is still open.
- ZIWEB0UW was moved before the amended rule existed: its mutation and its TypeScript test (src/test/parkedBodies.test.ts) are still owed and will be run when the load allows; if either fails the card returns to todo.
- Batch bounds, amended: at most 19 reviewers, serial, a total of 6 million subagent tokens, and no reviewer is started while the 1-minute load average is above 20 (it was 43 at 01:30 on 2026-10-05, so the batch is waiting).
- Commits ee4b6b6e and 8d515e76 belong together: the first holds only the UIDUVNY8 rename under a message describing five cards (git add stopped at the renamed file's old path), the second holds the other four cards. A card moved to a terminal column is relocated by trddgrep with the rename already staged, so only the new path is added from now on.
- CORRECTION for the archived card UIDUVNY8 (the tool refuses writes to archived cards, so it is recorded here): its review bullet says no file mentions ensureRamDisk or ramdisk. Only the first half holds. ensureRamDisk and the code that created the volume are gone, but a dozen files under src/ still mention the RAM disk in comments, tests and migration code, and src/cli/setup.ts still detaches an old disk image with hdiutil. Nobody checked whether a leaked volume still exists on this machine. The superseded verdict stands.
- Reviews so far (2026-10-05): deploy ZIWEB0UW 9SOYXKNE; superseded UIDUVNY8; todo LHCHVK9Z C19SUVPH L6V1UUW0 MVR6PXC0. Common cause of the returns to todo: the change is right on reading but no test would fail if it were undone.
- Reviewer workers must not run pnpm in this checkout: it aborted wanting to purge node_modules when run without a terminal (nothing was changed). They call node_modules/.bin/tsc and node_modules/.bin/mocha directly.
- Evidence usable by every Rust card reviewed today: on 2026-10-05, at a load average between 6 and 13, the main agent ran `cargo test -p agentlens-core -- --test-threads=4` (exit 0, 119 result lines all ok, 763 passed, 0 failed) and `cargo clippy -p agentlens-core --all-targets -- -D warnings` (clean), on the tree at commit 8d515e76 plus card edits only.
- Reviews so far, updated: deploy ZIWEB0UW 9SOYXKNE QE114936; superseded UIDUVNY8; todo LHCHVK9Z C19SUVPH L6V1UUW0 MVR6PXC0.
- Reviews so far, replacing the earlier tallies: complete UTFVMVT8; deploy ZIWEB0UW 9SOYXKNE; blocked QE114936 (by MVR6PXC0); superseded UIDUVNY8; todo LHCHVK9Z C19SUVPH L6V1UUW0 MVR6PXC0. Ten human_review cards remain.
- The full-suite evidence line above should read "tracked files at commit 8d515e76 plus card edits": that run itself produced one untracked file, now carried by its own card TRDD-IIT13XCA.
- The installed bundle (2026-10-01) predates the pidfile-owner guard that TRDD-L6V1UUW0 adds, so the doomed revive that card fixes is probably still happening on this machine until the bundle is rebuilt: inferred from the bundle's date, not read or observed.
