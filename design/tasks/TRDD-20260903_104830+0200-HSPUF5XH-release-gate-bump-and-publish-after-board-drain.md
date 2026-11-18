---
trdd-id: HSPUF5XH
title: Bump and publish agentlenspro only after every open card is terminal and every known issue is fixed
column: blocked
created: 2026-09-03T10:48:30+0200
updated: 2026-11-18T12:12:02+0100
current-owner: main-session
task-type: infra
min-approval-requirement: user
release-via: publish
created-by: main-session
npt: []
eht: []
pre-block-column: todo
blocked-by: [2R36W8Q1, N60JUWU3, CAJ5RCP9, QE114936, 768NEX6E, 7YPQWKPG, H3D5ZBO1, WCENKH6T, WBYDQH8K, ATXO2E1J, OLKITCS7, PGMMB2QG, QXODI7TR, JKVUBKLR, AXJH3WTU, MUZ04JYU, ASXUW08U, M62ZBT7E, ISEF8YO7]
post-release-verification: [IXMB2JVD]
blocker-probe: [trddgrep, why, HSPUF5XH]
blocker-holds-if: not-match:READY
assignee: main-agent@agentlenspro
status: tasked
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

**NEXT ACTION:** wait for `blocked-by` to drain. Re-run
`grep -H '^column:' design/tasks/*.md` and remove any id from `blocked-by`
whose card has reached a terminal column (`complete`, `cancelled`,
`superseded`) or moved out of the gating set (`dev|testing|todo|blocked|plan|dispatch`).
When `blocked-by` is empty, restore `column: pre-block-column` value (`todo`),
then proceed to run the acceptance gates below before touching version/tag.

**AFTER THE PUBLISH RUNS — do not close this card without doing this:** tick
`IXMB2JVD` box 1 from that run's `publish-npm` log, then move IXMB2JVD to
`complete`. It was removed from `blocked-by` on 2026-09-04 because its box can
only be checked after a publish exists; it now sits in `post-release-verification:`.
That field is a name of my own invention and **nothing parses it** (verified: no
script under `scripts/` reads these frontmatter fields at all — this board is
grep-and-human driven), so the reminder has to live HERE, in the block a resuming
session is instructed to read first, and in the release recipe at the bottom.
Removing a blocker without putting the work somewhere a human actually reaches is
how a deadlock becomes a silently-dropped verification instead — the same
disown-without-rehome failure that TRDD-CS2W7E77 was filed to repair.

**DEADLOCK BROKEN 2026-09-04T15:13:48+0200 — 17 → 16, by USER decision.**

`IXMB2JVD` was in `blocked-by` while its only open acceptance box reads *"The next release's
`publish-npm` job goes green end-to-end"* — which REQUIRES a release. This card IS the release. So
draining all sixteen other blockers would still leave a seventeenth that only a publish can clear,
and that — not any individual defect — is why this card had not moved. The card's own box 3 states
the circularity outright: "Proven by the NEXT release's run (box 1)."

**CORRECTION 2026-09-04, same day: an earlier version of this paragraph said the gate "could never
be satisfied" and "the board could not authorize a publish at all". That is OVERSTATED and is
withdrawn.** There was a path that needed no gate change: publish a PRE-RELEASE (the pipeline is
tag-driven, so `v2.33.3-rc.0` triggers `publish.yml`), watch `publish-npm` go green, tick
IXMB2JVD box 1 from that run, then cut the real release. An RC run *is* "the next release's
`publish-npm` job". The accurate diagnosis is therefore: **the gate required one publish to have
occurred, and the board offered no way to distinguish a proving publish from the real one.** That
is a genuine problem — it is not an impossibility.

This matters beyond wording: the USER's decision to unlink was taken on the "impossible" framing,
and the RC option was never put in front of them. The unlink may still be the better call (an RC
burns a public version number on npm, permanently, to prove a pipeline). But it was presented as
the only way out, and it was not.

Moved to a new `post-release-verification:` field, which gates nothing. Nothing is weakened: the fix
IXMB2JVD covers already landed (`f8b7560e`, the 30 × 20 s tarball retry), its tarball-property box
was verified by hand on v2.33.1, and box 1 still gets ticked from the publish run's own log — just
AFTER the event it verifies, which is the only order in which it can be checked.

USER decision, asked because this is a release-gate change and the second gate edit of the day:
"Unlink it — it verifies, not gates."

**Drain 2026-09-04T13:45:49+0200 — 19 → 17.** Removed `EAK9R8IY` and `DMWOBWFH` per this
card's own NEXT ACTION (both terminal AND in `design/archived/`, so the column claim is
corroborated by the folder). `DMWOBWFH` is `complete`. `EAK9R8IY` is `superseded`, which is
NOT self-evidently dischargeable — superseded work does not vanish, it MOVES — so its
`superseded-by: [1B98LCVR]` was followed: `1B98LCVR` is itself `column: complete` with
`blocked-by: []` in `design/archived/`. The successor is done, so the dependency is genuinely
discharged rather than silently dropped. Had `1B98LCVR` been open, the correct edit would have
been to SWAP the id, not remove it.

**Backburner triage 2026-09-03** (report:
`reports/board-sweep/20260903_111058+0200-backburner-triage.md`): WORK NOW → 99HUNXJS, 7NHUU6GK,
ZSX34J8F, 2R0AXCKL, TP3BA3ED, 2TQHNMEC are added to `blocked-by`; Z8WJZV8E archived superseded
(re-filed as TRDD-70D0TUBZ, itself added to `blocked-by`).

**ACCEPTED NON-BLOCKING by main-session:** E32TO0XC (explicit future-scope research, no defect),
IXVHM52P (fix landed, verification has a `review-after:` date and no repro set).

**ZSX34J8F is USER-GATED on the disk action:** 98 GB in `rust-core/target/debug`;
`~/.claude/rules/never_free_space.md` forbids the agent freeing disk space unilaterally — the
main session will propose the retention rule and the exact command and wait for the user before
this card can close.
**Correction 2026-09-24T09:06:25+0200:** `blocked-by` named 70D0TUBZ, which is now `superseded` — swapped for its successor U0L78B3Z (nothing-computes-capture-down-since-the-ts-server-was-retired) per board fix-up pass.

## User order (verbatim, 2026-09-03)

> "just bump and publish a new version. but do that only after you completed
> all TRDDs and fixed all issues."

## Approval log

- 2026-09-03T10:48:30+0200 — APPROVED by USER (verbatim order above).
- 2026-11-15 — blocked-by pruned per this card's own STATE rule (ids outside dev|testing|todo|blocked|plan|dispatch): removed 7NHUU6GK (backburner), ZSX34J8F (backburner), 2R0AXCKL (backburner), 2TQHNMEC (backburner), 9SYRK6SW (deploy); 13 remain.

## Blocking cards (must reach a terminal column before this gate opens)
> SUPERSEDED 2026-11-15: this list is historical; the live gate is the frontmatter blocked-by field (13 ids after the 2026-11-15 prune).

| id | column | title (file) |
|---|---|---|
| EAK9R8IY | blocked | ship-alcore-per-platform-npm |
| DMWOBWFH | blocked | rust-core-rewrite-ts-ui-only |
| 2R36W8Q1 | testing | summary-cache-livelocks-under-fleet-ingest |
| IXMB2JVD | testing | publish-verify-races-cdn-and-reports-a-good-release-as-failed |
| N60JUWU3 | testing | graceful-shutdown-starves-behind-a-state-lock-holder |
| UTFVMVT8 | testing | composition-routes-rebuild-the-summary-under-the-state-lock |
| CAJ5RCP9 | todo | durable-cache-event-history-joining-otel-and-statusline |
| 9SYRK6SW | testing | api-call-writer-at-bodies-pass-ingest |
| QE114936 | dev | mcp-tool-handlers-rebuild-the-summary-under-the-state-lock |
| POLG0613 | testing | one-unexplained-early-break-cold-write-after-a-heartbeat-fire |
| 768NEX6E | blocked | bodies-pass-scans-the-parquet-store-every-minute |
| 7YPQWKPG | todo | duckdb-is-the-memory-alcore-keeps-no-resident-data-model |

## User-gated cards (NOT blocking this gate — human_review/proposal/backburner)

These sit outside the pipeline's open-work zone by design (deferred or
awaiting a human verdict, not "in progress"); they do not gate the release
unless the user says otherwise:

- E32TO0XC — account-monitoring-skill-distillation (backburner)
- 99HUNXJS — server-and-cli-parse-port-env-differently (backburner)
- Q8ZW00CI — boot-warn-blames-the-documented-brake-override (human_review)
- IXVHM52P — duckdb-memory-ceiling-oom (backburner)
- Z8WJZV8E — sink-precondition-is-boot-only-and-never-reprobes (backburner)
- 7NHUU6GK — retention-gate-keeps-volumes-holding-a-re-emitted-body-forever (backburner)
- 465EXTJ6 — alcore-is-not-at-parity-with-the-typescript-server-on-14-behaviours (human_review)
- ZSX34J8F — target-debug-generation-accumulation-needs-a-sweep (backburner)
- 2R0AXCKL — real-corpus-tests-time-out-under-host-contention (backburner)
- TP3BA3ED — ts-store-twin-flushes-only-three-dirs (backburner)
- 2TQHNMEC — every-bodies-pass-rebuilds-the-dedup-sets-from-the-whole-corpus (backburner)
- 10NGH2BR — rss-guard-primary-metric-test-fails-intermittently (human_review)

## Definition of done — board drain

- [ ] Every id in `blocked-by` above has reached `complete`/`cancelled`/`superseded`
      (re-check `grep -H '^column:' design/tasks/*.md`; none remain in
      `dev|testing|todo|blocked|plan|dispatch`).
- [ ] No NEW card has entered the gating set in the meantime (re-check at the
      moment of publish, not just when this TRDD was authored).

## Definition of done — gates green (run in order, on this machine)

- [ ] `pnpm run compile` — passes (tsc ×2 + lint + esbuild ×4, includes
      `check-mirrors`, `check-identities`, `check-dist-contents`, `check-guards`).
- [ ] `cargo test` — rust-core store crate green.
- [ ] `cargo test` — rust-core core crate green.
- [ ] `cargo clippy -- -D warnings` — zero warnings across the workspace.
- [ ] alcore rebuilt from current source (fresh inode — verify via `ls -li`
      before/after, per `agentlenspro-ops-lessons-deploy-and-install`).
- [ ] Fresh-inode alcore deployed to the live server (`agentlenspro server restart`
      or the alcore-specific swap procedure — verify the running pid's binary
      is the new inode, not the old one).
- [ ] 15-minute hold read PASS (per O3ICDRLO's own acceptance recipe — no
      burn-tick hold ≥ 250ms observed over the window).
- [ ] The `api_call` table is observed filling on the live server (per
      9SYRK6SW's own acceptance recipe).
- [ ] Upgrade boot from a v2.33.1 data dir on a full corpus with the release alcore: record peak RSS against the cap and confirm the boot finishes its cold rescan (B' crash-loop check from 6B7VV2Z7; see Notes 2026-10-16).
- [ ] Two consecutive `pnpm run test:unit` runs, exit 0 and 0 failing, on the release tree as defined in the section "Release full-suite pair — gate rules" below, each following every rule there; record each run line under that section. Moved here from TRDD-CS2W7E77 on 2026-10-17.
- NOTE 2026-11-17T19:04:05+0100 (from the closing entry of TRDD-WCG7I5D8): before the first start of the new build on the live folder, confirm that log-delta-version.json is present and current there. A start whose version stamp is missing or stale refuses the store and tombstones the card log (log_reader.rs:975-977), which drops every card that has no transcript. A gate copy without that file did exactly this (74,730 cards discarded and rescanned); a later copy with a reused store kept them.
- BASIS of the note above (2026-11-17T19:06:03+0100): the copy lists of scripts_dev/wcg-gate4.py:30-31 and wcg-gate4b.py:38-39 hold six files and not log-delta-version.json; scripts_dev/yr6-gate-live.py:16 adds that file, and its run LV1 printed 'reusing cards.duckdb: 74730 cards'. The two copies were never compared in one controlled run, so 'the missing file caused the refusal' is INFERRED from those reads. Also: TRDD-WCG7I5D8 was moved to complete without a harness review of the close itself (two blocked rounds, then the advisor); corrections to it go to TRDD-PGMMB2QG.

## Release recipe (run only after every box above is checked)

Per `.claude/project/memory/agentlenspro-publish-pipeline.md` and
`CLAUDE.md` §Releases — OIDC trusted publishing, CI-only:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry —
   **same commit**.
2. Tag `main` `vX.Y.Z` (annotated), push the tag.
3. `.github/workflows/publish.yml` publishes to npm via the registered
   OIDC trusted publisher (no token, no local publish) with automatic SLSA
   provenance, then creates the GitHub Release.
4. Post-publish verification: registry `_npmUser` contains
   `trustedPublisher`, and `dist.attestations` exist for the published
   version. A human `_npmUser` with no attestations means the token
   fallback fired — investigate before declaring done.
5. Refresh local install (`npm link` / global reinstall as applicable),
   then `agentlenspro setup` to converge hooks/config to the new version.
6. **Close out `post-release-verification: [IXMB2JVD]`** — tick that card's box 1
   from THIS run's `publish-npm` log (green end-to-end, tarball verification
   included, no manual intervention), then move IXMB2JVD to `complete`.
   This step exists because IXMB2JVD was removed from `blocked-by` on
   2026-09-04: its box can only be checked AFTER a publish, so leaving it as a
   pre-release blocker made the gate unsatisfiable. Removing a blocker without
   putting the work somewhere a human will actually reach it is how a deadlock
   becomes a silently-dropped verification instead — the recipe is where a
   publisher looks, so the reminder lives here, not only in a frontmatter field
   that no tooling reads (verified: nothing under `scripts/` parses these
   fields; this board is grep-and-human driven).

**NEVER** publish locally (the 1.0.0 bootstrap is the only sanctioned
exception, already done), and **NEVER** add a `registry-url:` / auth token
to `publish.yml` — a present token silently masks OIDC.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-14

2026-10-14: blocked by 13 cards on 2026-10-14 (trddgrep why HSPUF5XH); on 2026-10-15 the frontmatter blocked-by lists 20, and that list, not the Blocking cards table in the body, is authoritative; see TRDD-AVUGZV1K STATE for the release work not yet done (setup preflight, Docker, dist guard); since 2026-10-17 the full-suite run pair is this card's own box under "Definition of done — gates green", not TRDD-CS2W7E77.
2026-10-14 release-goal state (owner goal: fix all issues, complete all TRDDs, publish). Work happens on branch fix/setup-agent-preflight; the review-gate work there (TRDD-QQ2XIIZ6, TRDD-LR4SI79M) is a detour the owner ordered mid-goal.
NOT DONE: setup stepSkill agent preflight (dry-run returns before agent drift is checked; skills install before a missing agent source is detected) — only checkpoints cf6af337 and 4a9e87e9 exist, no fix; Dockerfile still copies and runs the retired standalone/server.js (lines 39, 65) and lacks a target-platform alcore build, media/index.html and sidebar.js; scripts/check-dist-contents.js checks only forbidden paths, not declared skills/agents or Git tracking.
TRDD-CS2W7E77: focused serverCalibration run passed 5/5 on 2026-10-14 with alcore built at rust-core/target/release; the first full unit-suite run in a fresh worktree had 2,979 passing, 45 pending, 73 failing (exit 73), with 45 Cannot find module lines naming standalone/cli — run node esbuild.js before the suite; two consecutive full-suite runs are still required: since 2026-10-17 that is this card's own box under "Definition of done — gates green", with its rules in "Release full-suite pair — gate rules".
Environment: the collector was RUNNING but not answering on port 3000 after a 'revive backoff: 6 quick crashes' warning (not restarted); more than a dozen agent worktrees under .claude/worktrees likely cause the 5 s 'git worktree list' timeouts that crash janitor detectors; the main checkout carries unrelated dirty files (src/cli/hookInstall.ts AGENT_NAMES, agents/*.md, untracked agents/cheap-worker.md fast-worker.md smart-worker.md, a staged empty design/requirements/PRRD.md) that must be handled before merging to main.
These four lines duplicate the uncommitted STATE lines on TRDD-AVUGZV1K so they are restorable from git; this card is authoritative for them.


## Release notes owed (CHANGELOG)

setup honours AGENTLENS_DATA_DIR (c24058ce); users who set only it may meet a one-time refusal naming a stray ~/.agentlens server and its stop command.
setup refuses rather than migrating when a server owns a different data dir: changing DATA_DIR and re-running setup no longer stops the old server (973aead7, 29ec567a).
cache-expired no longer runs the first-run self-heal (42017224).
Do not run the release full-suite pair (the box under "Definition of done — gates green", formerly on TRDD-CS2W7E77) until the owner's pending decisions are made and HSPUF5XH's other blockers are terminal; any later code change voids it.
setup's HTTP calls have overall deadlines (10 s, MCP 15 s) and its stop, verify and self-test loops are wall-clock bounded, so a stalled server fails setup within seconds instead of hanging (973aead7).
setup refuses a stranger on the OTLP port even when our own server answers on the UI port: ownership is checked per port (973aead7).
setup no longer stops or restarts a server it cannot prove is its own; a server run from a renamed AGENTLENS_ALCORE binary is refused as 'not provably ours' (29ec567a).
review-gate: the gate no longer demands a review for a declared-role worker's scratch writes (temp, mktemp and date-stamped paths in ephemeral dirs); writes outside scratch dirs still arm it (df8bfc70, 668fc421, d476914a, ed0fbd5e, ed0fbd5e's follow-up). Known residual, open on TRDD-QQ2XIIZ6: an mktemp assignment that may not run (a compound-command body, a continuation) can leave the variable holding an inherited value; it needs a declared-role worker evading on purpose.
- TRDD-DA0GN1CS (landed in e3c3c388; ships in the next release): the periodic card save no longer scans DuckDB under the state lock; a DuckDB out-of-memory there poisoned the lock and stopped all ingestion while the server looked alive.
- TRDD-0BDOV3WC (when fixed): an out-of-memory read at boot no longer deletes cards.duckdb.
- TRDD-3RVTC1HY (when fixed): any panic exits the server so the hook revive restarts it.
- TRDD-6B7VV2Z7 (3a5874a5): when the card database is missing, unreadable or refused at startup, the server no longer trusts saved read positions that ran ahead of the card snapshot; it re-reads every log file, so missing or stale session cards are rebuilt. After an ingest-version upgrade, a deleted transcript's stale card no longer comes back.
- 2026-11-17T17:09+0100 FOR THE RELEASE THAT SHIPS e9782faf (TRDD-JDQR0HDT) and eef01b1d (TRDD-YR6WX7VQ), destructive on upgrade in one case: at the first start of the new build, a data folder whose card store ALREADY carries clear_in_progress = 1 (an interrupted clear) has its card snapshot tombstoned, cards of deleted transcripts included (their only copy), where the old build restored them. The CHANGELOG entry must say so. THIS MACHINE, read today: copies of the live card store report 'no clear in progress' (74,730 cards; reports_dev/YR6WX7VQ/gate/prep.log:5, gate-load/prep.log:5). Those copies ALSO printed 'card store reuse refused, the offsets log is stamped with another ingest version; discarding the cards and cold-rescanning': that refusal is an artefact of the gate script, which copies the card and offsets files but not log-delta-version.json (scripts_dev/wcg-gate4b.py:38-39), and version_is_current (log_reader.rs:908-913) refuses a folder with no stamp. The live folder's stamp reads {"v":7} and LOG_INGEST_VERSION is 7 (log_reader.rs:751), so by that check the live folder's first start reuses the store; not run on the live folder (the collector belongs to the owner and is taken as stopped from earlier in the session, not re-observed now). Before the first live start of a new build: read the stamp and the flag again.
- From TRDD-YR6WX7VQ (2026-11-17 17:51, commit eef01b1d, not yet pushed or deployed): (1) the full test suite is owed before the push; no full run has covered this commit. (2) The first start of the new binary on the live data folder appends the cards the files are missing in one save: on a copy of the live files that was 43,569 keys and 63,345,885 bytes; no tombstone, no compaction. (3) While the store is ahead of the card files a start holds the state lock about 4.5 s in the sweeper's restore (control binary 4,494 and 4,543 ms, patched first start 4,216 ms, at 74,730 to 75,106 cards); after the gap is closed the patched restart held it 614 ms (one run each). (4) Once per reused start the sweeper spends one file pass before its next loop: 0.34 s on the live copy on a quiet host, 32.9 s at 1.69 times the keys under host load rising to about 100, and on the smaller gate copies 10.5 to 113.4 s under load 23 to 215 against 1.9 s quiet; a stop that lands inside the pass exits without the sweeper's forced save, as a kill would (TRDD-QXODI7TR).

## Notes

2026-10-15: KMF02UEX, WCENKH6T, 3RVTC1HY and TYJSS45N added as blockers (0BDOV3WC was added in commit 44875736). The poisoned-lock incident (TRDD-DA0GN1CS) showed the same zombie can recur through any DuckDB .expect under the state lock in steady state or through a silently stopped sweeper, and 0BDOV3WC can lose cards on any restart whose reuse read runs out of memory; this card's title requires every open card to be terminal. The blocker-probe covers only the listed ids.
2026-10-15: DA0GN1CS completed (commit 1 e3c3c388; Rust 791/0, TS 3177/0) and left blocked-by; the rest of its class stays as blockers (3RVTC1HY, 0BDOV3WC, KMF02UEX, WCENKH6T).
2026-10-15: 6B7VV2Z7, WCG7I5D8 and USSG465Q added as blockers; they are the loss mechanism (6B7VV2Z7), the snapshot lag that multiplies it (WCG7I5D8), and the file bloat inferred to drive the boot out-of-memory (USSG465Q) behind TRDD-0BDOV3WC.
2026-10-15: TRDD-KBPB3UMH closed with a mitigation, not its original goal: the test still writes agentlens-prompts-claude.md into the crate dir while it runs (the endpoint writes to the server's cwd by design), and only guarantees cleanup. Decision: accepted as the final fix for a test-only, low-severity issue; the residual same-tree race and fixed-name removal are recorded on the archived card.
2026-10-15: CI has not run on this branch since 2026-09-02. ci.yml triggers only on push or pull request to main, origin/main is at 3e294e16 (2026-09-02), and 1268 local commits are not on origin/main, so every CI-only failure (Linux, runner size, cargo test --workspace concurrency) is untested for all of them. Running CI needs a push or a pull request, which is the owner decision. Raised with the owner 2026-10-15.
2026-10-15: inconsistency recorded, not fixed: 7NHUU6GK, ZSX34J8F and 2R0AXCKL are in blocked-by, yet this card lists all three under User-gated cards (backburner, NOT blocking this gate). The owner or a later pass decides which statement holds.
2026-10-15: MEPIRHI4 (b4cdf24c, 6afa002b) and 59OONXOV (3f152419) landed; neither is in blocked-by.
2026-10-15: 7EZE3AIZ added to blocked-by: the shutdown test flake, three local occurrences, never run by CI; a rerun-until-green would make the CS2W7E77 pair meaningless.
2026-10-15: correction to the CI line above: origin/main was re-fetched on 2026-10-15 and is still 3e294e16 (2026-09-02); the count of local commits not on it was 1268 before 6afa002b and 1269 after, and it grows with every commit.
2026-10-15: correction to the 7EZE3AIZ line above: the CS2W7E77 pair is two pnpm run test:unit runs (mocha), which do not run cargo test. The Rust flake threatens this card s own box cargo test rust-core core crate green and the CI Rust step (ci.yml:299), not the CS2W7E77 pair.
2026-10-15: correction to the inconsistency line above: four cards overlap, not three. 7NHUU6GK, ZSX34J8F, 2R0AXCKL and 2TQHNMEC are all in blocked-by and all in column backburner (checked 2026-10-15), while the User-gated list says backburner cards do not block this gate.
2026-10-15: unowned, recorded here: the GitHub Dependabot Updates workflow failed on each of its 5 newest runs (2026-09-29 to 2026-10-07, gh run list); cause not examined.
2026-10-15: the Blocking cards table above is stale: it lists ids (for example EAK9R8IY, DMWOBWFH, IXMB2JVD) that are not in blocked-by. The STATE block works from blocked-by.
2026-10-15: correction to the line above that says this card s own box: it means the box cargo test rust-core core crate green on this card (an apostrophe was lost in shell quoting).
2026-10-15: ZRXECDAQ met at f7a4945a (16 of 16 Linux runs of the memory-edge test) and moved to complete; removed from blocked-by.
2026-10-15: 10NGH2BR added to blocked-by: the rss_guard primary_metric test failed 2 of 10 Linux full lib runs at 84f3b0f8; CI runs that test on Linux with no retry.
2026-10-15: 7EZE3AIZ met (84f3b0f8, 7c077027; shutdown test ok in 20 of 20 full lib runs) and moved to complete; removed from blocked-by.
2026-10-15: gate evidence at 7c077027 (macOS): cargo clippy --workspace --all-targets -- -D warnings exit 0; cargo test --workspace 980 passed 0 failed; pnpm run test:unit 3177 passing 0 failing; release build fresh, --version exit 64. Boxes stay unticked: they are run after the board drains, and pnpm run compile, the live deploy, the hold read and the api_call check were not run.
2026-10-15: possible CI timeout, inferred and not measured on a CI runner. The rust job in ci.yml (line 254) runs clippy and then cargo test --manifest-path rust-core/Cargo.toml --workspace, under timeout-minutes: 40 (line 257). On 2026-09-02 that job took 2 to 10 minutes on GitHub's runner (runs 33667160582, 33666353235, 33646696194), for the suite as it was then. On this Mac at 7c077027 the durations of the 147 test-result lines summed to 1460 s, compile time not counted, the slowest 514.62 s; the 1-minute load was 10.7 at the start and 20.2 at the end, the 15-minute load 37.5 at the end. In an emulated linux/amd64 container under host load at cc0cee02 the first 80 binaries took 3206 s summed, tests/card_store.rs alone 2825.87 s. Whether today's suite fits in 40 minutes on a native runner is unknown until CI runs.
2026-10-15: 10NGH2BR removed from blocked-by and listed under User-gated cards. It blocked the release because CI runs that test on Linux with no retry; cc0cee02 runs it alone in its own process, which removes the shared-process failure path by construction, and the moved test passed 20 of 20 Linux runs. What remains on 10NGH2BR is an owner decision on the wording of boxes 1 and 3 and a cause that is not established, so the release no longer waits on it. The same rule was not applied to the four backburner cards still in blocked-by (7NHUU6GK, ZSX34J8F, 2R0AXCKL, 2TQHNMEC), which stay for the owner or a later pass.
2026-10-16: the deployable set now includes 542ceca2 (TRDD-3RVTC1HY): any panic now exits the collector and the hook revive or supervisor restarts it; a request-triggered panic restarts it (five unclassified request-path sites: card HFY30YBT). Keep 3RVTC1HY on this card's blocker list until it is terminal.
2026-10-16: drops TYJSS45N (complete); adds WBYDQH8K (the watcher test fails about one run in five on an unmodified tree, a known issue the release gate requires fixed).
2026-10-16: adds ATXO2E1J (functions and closures that still return a Result that cannot fail).
2026-10-16: adds OLKITCS7 (request-path panics beyond unwrap and expect, the dependency caught-panic question, and the late-panic restart without backoff). Also noted there: publish.yml does not run cargo test, so a release must come from a commit CI passed.
2026-10-16: adds JDQR0HDT (the snapshot restore path can bring back cards a schema bump or an interrupted clear meant to drop).
2026-10-16: 6B7VV2Z7 complete (3a5874a5 fix, aecdade6 test) and removed from blocked-by. Carried here because that card is archived and frozen: (1) the local alcore is NOT redeployed with 3a5874a5; deploy = release build, copy into bin-native/<platform>/, codesign, server restart. (2) Every refused-reuse boot now cold-rescans the whole corpus; neither that cost nor how often a current-version refusal happens is measured (the closing note's 'rare path' is an inference). (3) The eager offsets tombstone in restore_from_snapshot is untested; that it protects a later reused boot comes from its own code comment. (4) aecdade6's after-backfill check likely had no backfill candidate (the fixtures already carry cacheCreate1hTokens), so it shows no harm to filled cards, not that filling keeps totals. Verification of 6B7VV2Z7's closing STATE: the assert_same_cards calls at tests/card_reuse.rs:637 and :667 and the helper's body (:519-527: no missing or extra card id, every card equal) are verified by reading; they compare the persisted form.
2026-10-16: OPEN release check from 6B7VV2Z7 (its archived card, line 42, names the B' crash loop): the startup sweep persists no read positions until it returns, so a boot that dies at the RSS cap inside a full cold rescan repeats it on every restart. 0BDOV3WC took out-of-memory off this path; the remaining triggers are a card-schema bump, missing meta, an interrupted restore or clear, corruption, and a MISSING store. cards.duckdb (card_store.rs, CARD_SCHEMA_VERSION 1) did not exist at v2.33.1, so the first boot after upgrading from 2.33.1 likely takes this path (checked 2026-10-16: tag v2.33.1 exists, card_store.rs is absent there, LOG_INGEST_VERSION is 7 at both, so that boot is a missing-store refusal, not version-stale; the boot itself is not run, and whether 2.33.1 boots already re-parsed everything is unknown). Before publishing: boot an upgrade from a 2.33.1 data dir on a full corpus and record peak RSS against the cap; the memory side is owned by USSG465Q (file bloat); related: 9VX3WTGU (store reuse). Enforced as a gate box under Definition of done — gates green.
2026-10-16: related to the upgrade-boot gate box, TRDD-AJGTQ007: DeltaLog::load holds about 6.7x the on-disk size, and on this machine the card snapshot alone peaks at 478 MiB during that boot. The load-time spike is measured to rarely coincide with a death (28 of 1,539 cap deaths fall in the first 30 s); its share of the steady footprint and of deaths on refused-reuse boots is unmeasured. Not added to blocked-by; the gate box's peak-RSS measurement will show whether it matters.
2026-10-17: 1RJBOEI1 added to blocked-by. N6A8VX3G's body-links writer ships in this release, and boot compaction of that log peaks at 3337 MiB at 700k records (measured), so without a fix every install reaches a boot crash loop as the log grows.
2026-10-17: 1RJBOEI1 complete (5e39aa3b, 404b0021): boot compaction of a 700k body-links log now peaks at 184.7 MiB, down from 3337 MiB. Removed from blocked-by. The fsync gap it found is TRDD-O8MGRU72, now in blocked-by: this card's gate requires every known issue fixed, and that one is a data-loss window. Exempting it is an owner decision.
- 2026-10-17, before release: (1) confirm CI on ubuntu passes an_unsyncable_temp_snapshot_is_refused_and_keeps_the_old_snapshot (Linux behaviour of the /dev/null sync is unmeasured, TRDD-O8MGRU72 residue c); (2) the local alcore binary is not redeployed since at least 6B7VV2Z7 and O8MGRU72 — rebuild, codesign -s - --force, restart and check alcore --version is not 137 (residue d).
2026-10-17: the two-green-full-suite-runs requirement, previously carried by TRDD-CS2W7E77 (Notes lines of 2026-10-14 STATE and the CHANGELOG section), is now the box "Two consecutive `pnpm run test:unit` runs ..." under "Definition of done — gates green", with its rules in the section "Release full-suite pair — gate rules". CS2W7E77 stays in blocked-by until it reaches a terminal column.
2026-10-17: owed, not done: TRDD-AVUGZV1K STATE still lists "CS2W7E77 full-suite runs" as release work; retarget it to this card's box under "Definition of done — gates green" once the other session's uncommitted edits to that file are committed. TRDD-4BZPAQWM also lists CS2W7E77 in blocked-by; drop it there when CS2W7E77 closes.
2026-10-17: CS2W7E77 complete (fix c7c540c8, mutation-verified 2026-10-17); removed from blocked-by and from TRDD-4BZPAQWM blocked-by. Its tests 2 to 5 are order-dependent on test 1: TRDD-A77UKLVI. The TRDD-AVUGZV1K STATE retarget is still owed.
2026-10-17: A77UKLVI closed (c65252c3, 1e22ca29). Its evidence line "Runs at HEAD 1efc0d24" means 1efc0d24 plus the test change committed as c65252c3: reproduce at c65252c3. Per-run load was not logged (runs were gated on a 1-minute load at or below 20).
FROM TRDD-RTHA7EWK item 5 (commit 69caf856, 2026-11-18), owed in the publish pass: (1) README, the agentlenspro-diagnostics skill and every --help page name the view agentlenspro statusline-history refused, the sealer log <dataDir>/statusline-seal.log and the variable AGENTLENS_STATUSLINE_SEAL_RETRY_BASE_MS (the usage text of statusline-history and of alcore statusline-seal already do, in source); (2) the bundle and the release alcore must be rebuilt and deployed before the installed CLI has the view, the log or the markers: only the debug build and the compiled test output were run; (3) rustfmt was not run on the Rust changes of this item.
- 2026-11-18 ALCORE DEPLOY PLAN AND STATE (main agent). LIVE, read by the main agent: bin-native/darwin-arm64/alcore 55,946,528 B, dated 2026-11-18 04:04:26, sha1 39df76032f7cb0947c1f524e4b28fa6a47dc8ee0, unchanged; where and from which commit it was built is not known (before today rust-core/target/release/alcore was dated 2026-11-15 17:10, so the 04:04 file was not built there). alstore 41,879,440 B dated 2026-08-29. alscan and allogscan are ABSENT from bin-native/darwin-arm64. Nine alcore.* copies sit in bin-native/darwin-arm64, a folder named in the files list of package.json: proposal to the owner, move them to builds_dev before the next pack. BUILD: release build at HEAD 15e5a1b8 finished (one Finished line, 5m 38s); rust-core/target/release/alcore 56,292,560 B, dated 2026-11-18 11:28:35, sha1 ca7ddbbf83acf1b3e627d97ce65a7eb62f1e1a37 (listing and hash read by the main agent; report reports_dev/cheap-worker/20261118_w22-alcore-rebuild-2.md). The build started while the 5-minute load was about 55: the load gate of the worker tested the 1-minute value. The fresh file has passed NO valid check yet: --version is not a command of alcore (exit 64 with the usage text), and alcore is not to be run with no subcommand. Rust commits after the 04:04 file by commit time: e9aa6ef4 (04:10, may already be in the live file), e5a0aec5, e8607b1f, 73211a46, 69caf856, 70d92220, 15e5a1b8. NEXT, one worker: (1) the four test binaries statusline_parity, statusline_usage_parity, statusline_seal_cli, statusline_seal_backoff, one at a time; (2) a smoke of the release file: statusline-seal on a scratch data dir with a past-day wal-cli.ndjson of 3 lines, expect exit 0, the text sealed 1 WAL and one parquet part; (3) only if all pass: copy the live alcore to builds_dev, copy the new file to a temp name beside it, codesign -s - --force, the same smoke on the signed copy, rename. No server start. alstore, alscan and allogscan are staged at the publish pass by scripts/safe-deploy.sh. BUNDLE: standalone/cli.js was rebuilt at 11:08 with a bare node esbuild.js, without the gates of scripts/safe-deploy.sh (check-types, lint, check-no-mirrors, compile-tests, a mocha gate, a smoke); rollback copy builds_dev/pre-search-deploy-20261118/cli.js. The next rebuild runs check-types, lint, check-no-mirrors and compile-tests by hand first; the mocha suite runs before the push; the smoke body of the script was not read. ALSO FOR THE PUBLISH PASS: install of review mod 0.7.12 (TRDD-ISEF8YO7; live sessions run 0.7.10).
- 2026-11-18 ALCORE STAGED 11:41:27 (worker W23, report reports_dev/cheap-worker/20261118_w23-alcore-stage/report.md, read whole by the main agent). READ BY THE MAIN AGENT AFTERWARDS: bin-native/darwin-arm64/alcore is 55,965,424 B, dated 2026-11-18 11:41:27, sha1 3106c18a48e6fb0177a23e86845866782f6f8341, codesign -v rc 0. The former live file is kept at builds_dev/pre-alcore-stage-20261118/alcore (sha1 39df7603..., 55,946,528 B). ROLLBACK: copy that file over the live path by rename. WHAT WAS CHECKED: by the report, the four test binaries passed (statusline_parity 3, statusline_usage_parity 6, statusline_seal_cli 10, statusline_seal_backoff 8 tests, each cargo rc 0, no rerun) on the DEBUG build that cargo test makes, not on the release file; three statusline-seal smokes of the release file (before signing, signed copy, live path) each ended rc 0 with the text sealed 1 WAL and one parquet part; the part of the third smoke read back by the main agent holds 3 rows in 2 sessions. BUILD PROVENANCE, read by the main agent: the build output file holds one Finished release line; the binary is dated 11:28:35, after the commit time of 15e5a1b8 (11:14:41) and after the date of statusline_store.rs (11:12:07); git status of rust-core was empty. The text sample_size=-1 occurs 3 times in the new file and 2 times in the former one, which fits the reader fix being compiled in. NOT CHECKED: the serve path of the release file (the late-key reader fix was run only as the debug test statusline_late_key_reader before commit 15e5a1b8, not on this file); the memory guard, back-off and purge-gate changes under a running server; alstore, alscan, allogscan (not rebuilt). No server was started; a process that was already running the former file keeps it until it ends. The load gate of W23 read the 1-minute value (16.57 at its step 3; 29.27 at launch while the 5-minute value was 53.76). SEARCH FORMS RERUN ON THE LIVE BUNDLE (standalone/cli.js sha1 d7699375...; this project, since 2026-11-18, 90 transcripts, 362 MB, one run each): --word rc 0, 192 matches; --mask rc 0, 192 matches; --fuzzy rc 0, 1 match; --show of one hit rc 0, 4 lines. Outputs reports_dev/main-agent/20261118-search-live-*.out and .err.
- 2026-11-18 ADDED after the review of W23 (main agent): (1) GATE BEFORE THE FIRST SERVER START on the new alcore: run alcore serve on an isolated data dir (own HOME, free ports, never 4318, --no-log-scan --no-collection) with a write-ahead file of 20,481 rows and one later row holding a new key, and read that key through the status-line reader; until then the live file is NOT tested for the reader fix of TRDD-ZKNP5IJY (alcore has only the commands serve and statusline-seal, so the reader runs only under serve). (2) Signing changed the size from 56,292,560 B to 55,965,424 B (about 327 KB less); cause not read, the signed file passed codesign -v and two smokes. (3) Provenance has no build record beyond the output file: the build started after commit 15e5a1b8 on a clean rust-core tree, by the reports of W22.
- 2026-11-18 CORRECTION kept here because TRDD-ZKNP5IJY is archived and cannot change: its close reason says each fix has a test that failed before and passed after. For the TypeScript half the red and green runs were taken with the reader edit and the two seal edits applied together, so the seal test is not shown to fail on the seal change alone (the Evidence notes of that card say the same).
- 2026-11-18 RULE for the next swap of a live binary (main agent, after a review): copy the live file to a backup folder first, and the worker prompt pre-decides that the backup is copied back when the smoke of the staged file fails. The swap of 11:41 had no such branch; its three smokes passed.

## Notes and lessons learned

2026-10-15: BSLCSCYK is listed because demotion failing at 256 MiB would leave timelines unstripped and resident memory growing; MEPIRHI4 (failure handling of one card) is not listed, as no repeating per-card failure has been shown; the title-level drain rule still covers it.
2026-10-15: BSLCSCYK removed from blocked-by; it was completed and archived in b0fd9bc5 but left in this list until now.
2026-10-16: the live collector (pid 55408, bin-native binary from 2026-10-03) has been a zombie since 2026-10-14 16:21:56 (log-sweeper panic 'scan the cards for persistence' OOM, state lock poisoned, no ingest). The panic site was removed by e3c3c388 (TRDD-DA0GN1CS); 4d5db2dc (TRDD-0BDOV3WC) adds the lossless OOM rewrite. Deploying the current alcore and restarting needs the owner's approval; back up ~/.agentlens card files first.
2026-10-16: deploy facts for the owner's choice: deploying the current alcore ships every change since the 2026-10-03 binary, unexercised in production; recipe per CLAUDE.md: `node esbuild.js`/cargo release build, copy into bin-native without overwriting the running file in place, `codesign -s - --force` on the copy, check `alcore --version` does not exit 137, back up the full ~/.agentlens card set (cards.duckdb, its .wal, the card snapshot), then `agentlenspro server restart`. A restart with the OLD binary keeps the lossy OOM delete path, and the live cards.duckdb passes the boot read at 256 MiB but fails at 224 (thin margin), so a plain restart can delete and rebuild the card store and lose cards.
2026-10-16: restart caveat for the hung live collector (pid 55408, poisoned state lock since 2026-10-14 16:21:56). `agentlenspro server restart` first runs stopServer (src/cli/serverControl.ts:577-612), which sends SIGTERM, waits 15 s, and then throws 'still running 15s after SIGTERM' WITHOUT escalating to SIGKILL. Whether the 2026-10-03 binary's graceful shutdown completes with the poisoned lock is UNVERIFIED (TRDD-N60JUWU3 covers shutdown waiting on the state lock). If the stop times out: after backing up the card files, kill only pid 55408 by force (kill -9 55408), then run `agentlenspro server start`. A forced kill skips the final saves; the read positions saved up to 16:21:56 survive, so log-sourced sessions should be re-read (INFERRED); OTLP spans posted during the outage were most likely refused and are not recoverable by a restart (INFERRED).
2026-10-16: the forced-kill fallback above is the owner step inside the owner-approved restart, not a standing authorization. Before kill -9, confirm with ps -o pid=,command= -p 55408 that the pid is still alcore, or use the pid agentlenspro server status reports.
2026-10-16: the deployable set now includes ddb58799 (TRDD-USSG465Q): the card store opens with vacuum_rebuild_indexes at u64::MAX, so checkpoints reclaim dead rows; a DuckDB that refuses the option makes alcore panic at boot before touching the card files.
2026-10-16: USSG465Q removed from blocked-by: it is complete (ddb58799).
2026-10-16: drops 3RVTC1HY (complete; not yet deployed, which is this card's step).
2026-10-17: O8MGRU72 complete (commits 3a9ec263, 45a7711a, 14e33321) and removed from blocked-by; its open residue (one intermittent watcher test, one SIGKILLed full run) is recorded on its STATE block.

## Release full-suite pair — gate rules

- Consolidated 2026-10-17 from the dated Notes of TRDD-CS2W7E77 (2026-10-14 and 2026-10-15), where the history and the reason for each rule stay. Corrections to these rules go HERE, not on CS2W7E77.
- Before each counted run, build alcore from HEAD: `cargo build --release --manifest-path rust-core/Cargo.toml -p agentlens-core --bin alcore`. Then a no-op rebuild, which must print no `Compiling agentlens-core` line. Then `rust-core/target/release/alcore --version` must exit other than 137 (137 is a SIGKILL before main; alcore has no --version flag, so 64 is the expected exit). Then take the binary sha256 last, run the suite, and take the sha256 again at run end: a changed sha voids the run.
- Do NOT codesign rust-core/target/release/alcore: a codesign makes the next cargo build re-copy the output and change the sha. The codesign step in CLAUDE.md applies to the bin-native copy only.
- `git status --short --untracked-files=no rust-core/` prints nothing at run time.
- AGENTLENS_ALCORE is unset (the TS tests pick AGENTLENS_ALCORE, then rust-core/target/release/alcore, then bin-native: src/test/helpers/freePort.ts).
- Run `node esbuild.js` before the suite (a fresh worktree without it failed 73 tests on `Cannot find module` for standalone/cli). If the installed agentlenspro resolves into this checkout (check with `ls -ld $(readlink -f $(which agentlenspro))`), that rebuilds the installed bundle, which TRDD-AVUGZV1K reserves to the owner: run the pair in a separate worktree instead, or only with the owner's word. A worktree run needs, inside the worktree: dependencies installed (call node_modules/.bin tools directly; pnpm without a terminal has aborted wanting to purge node_modules), alcore built there under every rule of this section, and node esbuild.js run there. A fresh worktree holds none of the owner-pending files, so it tests the committed tree and the five TESTED-STATE hashes do not apply; committing those files afterwards is a code commit and voids the pair.
- The CLI hot-path latency guard skips when the 1-minute load / CPUs exceeds 2; a pair counts only if at least one of its two runs EXECUTED the guard (its log shows the test passing, not a SKIPPED line).
- Each run line records: HEAD, binary mtime and sha256, the 1-minute load at the start of the TypeScript suite, and the dirty working-tree files.
- Any code commit after run 1 voids the pair. A commit counts as docs-only when `git diff --stat <A> <B> -- src rust-core media standalone package.json scripts` is empty. Agent proposal, NOT ratified by the owner (this card needs the owner's approval): the release bump commit would not void the pair when its diff from the HEAD of run 2 touches only CHANGELOG.md and the `version` line of package.json (check with `git diff <run-2 HEAD> <bump commit> -- . ":(exclude)CHANGELOG.md"`, which must show only that line). Until the owner rules, the pair runs on the bump commit itself, which conflicts with the release recipe order (bump only after every box is checked): an open owner question. Before ratifying, grep src/test and scripts/check-* for reads of the package.json version and of CHANGELOG.md, because the diff check does not cover a test that reads them.
- TESTED-STATE: CI publishes from the committed tree, so the release tree is the committed tree. While the owner-pending change in src/cli/hookInstall.ts (AGENT_NAMES gains cheap-worker, fast-worker, smart-worker), the untracked agents/cheap-worker.md, agents/fast-worker.md, agents/smart-worker.md, and the `skills: [ultimate-bug-scanner]` line in agents/agentlens-tldr-worker.md and agents/micro-worker.md stay uncommitted, a pair run on the working tree counts only if the release commits all of them unchanged (snapshot sha256 values: TRDD-CS2W7E77 Notes, "TESTED-STATE SNAPSHOT"), and only if those five hashes, re-taken after each run, all match the snapshot. Any other owner decision on them requires one more pair on the committed tree.
- Do not run the pair until the owner pending decisions are made and every other id in blocked-by is terminal.
- These runs are local only: CI has not run on this branch since 2026-09-02 (see Notes).

## Owner directive 2026-11-18

2026-11-18T01:20:09+0100 — OWNER, 2026-11-18 (verbatim): «i remember telling to publish whenever you want, and to deploy the most up to date version so it can be used. also the updates must trigger the updates of all installed extensions and hooks in claude.» This is newer than the order recorded on this card («just bump and publish a new version. but do that only after you completed all TRDDs and fixed all issues.») and governs the timing. READING of the main agent (not the owner words): publish when the local deploy of the merge of feat/rbbex59r-c2 is observed clean and the full suite has run once before the push; the never-push rule is lifted for the release only. OPEN before tagging: the waiver of TRDD-12FGMAEP on TRDD-RBBEX59R was read as given for this machine, while a publish ships that alcore to every install; the owner is told in the status so a veto is possible.
2026-11-18T01:20:35+0100 — OWNER, 2026-11-18 (verbatim): «remember to update the changelog, the readme, and any documentation or --help page before publishing.» Gate for the publish: CHANGELOG.md, README.md, the documentation and every --help text are brought up to date first.
2026-11-18T01:38:43+0100 — Question 1 of the main agent was: a publish ships the new alcore, without the whole-process memory ceiling of TRDD-12FGMAEP, to every install; publish, or hold. OWNER, verbatim: «no idea what are you talking about. probably i forgot. decide yourself. solve the matter yourself if necessary.» The point OPEN before tagging above no longer waits for the owner: the main agent decides it on verified facts and records the decision in this section. Fact read on 2026-11-18: commit 567fc5c2 (the retirement of the TypeScript server) is NOT an ancestor of tag v2.33.1, and npm view printed 2.33.1 as the published version, so the next publish is the first one where alcore is the only backend.
- Decision (main agent, 2026-11-18, on the owner's «decide yourself. solve the matter yourself if necessary.»): the next publish is the first release whose only server is alcore (commit 567fc5c2, the retirement of the TypeScript server, is not an ancestor of v2.33.1, and npm serves 2.33.1). A whole-process memory ceiling (TRDD-12FGMAEP) is therefore added and tested before the tag. Its value is chosen on that card.

## Notes 2026-11-18

FROM TRDD-12FGMAEP (commit 73211a46, footprint backstop in the memory guard of alcore): owed before the tag. (1) Deploy: release build of alcore, copy into bin-native/darwin-arm64, codesign, --version check; the running binary predates the commit. (2) Text: README, the diagnostics skill and every --help or reference that lists environment variables must name AGENTLENS_FOOTPRINT_BACKSTOP_MB (default 3 x the commit cap, lowered to half of the physical memory when smaller and above the cap; an override counts only above the cap) and the exit 1 with the label FOOTPRINT BACKSTOP in rss-hard-cap.log. The CHANGELOG entry exists (Unreleased). (3) The CHANGELOG still owes one line for commit abe31c03 (TRDD-RTHA7EWK item 4).
