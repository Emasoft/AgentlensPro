---
trdd-id: C9BGEMSS
title: Drain the board, complete every pending task and TRDD (program 2026-09-24)
column: dev
created: 2026-09-24T08:53:04+0200
updated: 2026-09-24T10:24:47+0200
current-owner: Emasoft
created-by: Emasoft
task-type: infra
min-approval-requirement: none
assignee: Emasoft
mandate: true
mandated-by: none
approved: true
approval-judge: Emasoft
approval-datetime: 2026-09-24T08:53:04+0200
priority: high
---

# Drain the board, complete every pending task and TRDD (program 2026-09-24)

## Approval log

- 2026-09-24T08:53:04+0200 — MANDATE issued by Emasoft (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24T10:24:06+0200

Handoff snapshot. HEAD at handoff was c0606d4b, then corrections (check git log). Today's commits, in order: cf46888e through 8f9fb461, 92a75e20, 6c246701, 78e84e7f, 02ea2cba, fd4b679a, 9c363bb8, 25113e6d, 954fe1a0, 3faa709c, 7ecc6ad7, fbd4ae8d, c0606d4b, then this correction.

Deployed vs not: alcore is deployed at 78e84e7f (TRDD-HNPT6JRG), with the rollback binary saved as alcore.prev-20260924 in bin-native/darwin-arm64. The TS bundle (standalone/cli.js) is NOT deployed — BA0DCW98's fix, J2K6IM4R's fix, and the delegate-gate verb all sit uncompiled/unrestarted on disk.

Deploy prerequisites before restarting the TS bundle: (1) the cross-project marker scan requested by this program — DONE, result: 19 violations of a buried (not first-line) ROLE: REVIEW/ROLE: MEASURE marker in Agent/Task prompts over the last 7 days, all in OTHER projects (llm-externalizer: 10, ai-maestro-janitor: 9), none in this project; no skill/agent/command template puts prose before the marker (the only file hits were mid-sentence prose in a TRDD card body, not a template). (2) bundle delta since 2026-09-15 — not yet measured. (3) a rollback copy of standalone/cli.js — not yet taken. (4) a live probe after restart — not yet run. (5) the YGETIBJS hold decision — still pending, unresolved.

Owed: TRDD-2CYTNLY1 carries a stale AI approval (its human_review verdict predates today's reviewGate.ts rework) — a note was appended to it this pass (## Stale approval, 2026-09-24) saying a re-review at HEAD is owed before owner acceptance. A full `trddgrep validate` pass is also owed before the next board commit (see below).

Phase-3 queue, in order: 4BZPAQWM (compile is red on main — do this first), then CEAZZHHO, PQ40PZ9D, PNB9FNJ0, VDQ2N8PX, K4XQ7M2B, 82ADFE5D, L2HVOB5K, HCK5162J, P08Q5TK1, then 8ADTIGKT (the Rust pinning test), GXKRBK1Q, FGN5TY7E (a mutation run), then DRH4ZRGB's two open rows, then 4EV3OJ19, N6A8VX3G, 091Z1FU0, RAPDS7OX, then the multi-day programs (40M4UPK3 stage 2, the DuckDB program 7YPQWKPG/DKBGT7MQ/KBM09XHB, Q9WD3K5R, 3UJB4MN3, the N6A8VX3G chain, 5D0VU5NJ, D8L28FFD). ALSO OWED (movement and verification, not implementation — drain these alongside the queue): HNPT6JRG's AI review (it is in ai_review); BA0DCW98 and J2K6IM4R AI review (moved to ai_review 2026-09-24; BA0DCW98 box 2 is the 8YM21R5X residual); Z0A777XW box 3 (an isolated-instance run; in testing); B07NR7ZI (node esbuild.js and setup --dry-run: do NOT run until the owner answers decision (3) — on this machine esbuild IS the deploy, hooks pick up the bundle at once); 5JZQFVO8 box 5 (cargo test --workspace); WKLD508O (its acceptance has no checkboxes: decide the move); 9SYRK6SW step 3 (restart survival); testing column: 3EZ6SJ2Z (live observation), GR6WHHK5 (its fix predates the 78e84e7f alcore build, so it is likely already deployed: verify, then move), HFV4AIT7 (real-corpus measurement), N60JUWU3 (lock-holder harness), POLG0613 (waits on CAJ5RCP9 child 1), EJDNNDY3/QJPUG1WP/IXMB2JVD (wait on a push); 5YL1OQV1 (design; its blocker ZW4APOPI is now in human_review); 8YM21R5X; the 2CYTNLY1 re-review.

NDKKOABG needs no push: its CI rust job was already green at 3e294e16 (ai_review-B triage). EJDNNDY3 and QJPUG1WP do need a push for their CI boxes.
Owner decisions PENDING (this numbering supersedes the one in the chat summary) — NONE has been made; the owner has said nothing since the order. Correction 2026-09-24: an earlier version of this line listed several of these as "already made" and invented an owner ruling on VNKPUAY4; that was a worker's misreading and is false. (1) May AI-approved cards skip human_review? About 31 wait there. (2) Confirm or reopen the EIGHT early terminal moves made before that authority was withdrawn: P46MEOXA, D7MCI7OA, U84BCXKQ, 1YXR6S47, ZPSB2WZJ (complete), 70D0TUBZ (superseded), H0ZDM156 (cancelled), QW394APJ (refused); each Approval log says which acceptance boxes were struck or added. (3) Deploy the TS bundle (BA0DCW98, J2K6IM4R, the delegate-gate verb): machine-wide effect; 19 recent spawns in llm-externalizer and janitor sessions put the ROLE marker after a first line and would each hit one gate block until the new message teaches the rule. (4) Push main (611+ commits) so CI can close EJDNNDY3 and QJPUG1WP. (5) BLAV6W15 (one path vs one node); 0E3W5C45 (does option A stand); X8MW8K92 (gate opus too?); 81BW1CS9 (cancel: its data is gone). (6) I5O38KKP and M2VK8T4P (CI workflow edits); TN7FDRGW (file an issue on the janitor repo); EGGERLEO box 1; FK4AXP7M (trddgrep stamps the OS username as the approver of agent moves: an approval-provenance defect); DIZ289UQ's disclosed substitutions; HSPUF5XH (publish: only on the owner's explicit word); issue #19 closure after DCWJY2JJ closes. (7) VNKPUAY4 sits in complete but trddgrep's false-completion guard refuses to archive it: needs a look. (8) Disk is 97% used, 61 GB free; cargo clean on rust-core/target would free about 21 GB. (9) 7FA3NIXU and GG0WOHEV: the backburner triage found both OBSOLETE and named no replacement card, so neither can be superseded. Cancel them? Cancelling is a terminal move, on the owner's word only.

Operating facts for whoever resumes this card: never run the full mocha suite (`.mocharc.cjs`'s `spec: ['out/test/test/**/*.test.js']` glob is additive — CLI `--spec`/positional args do NOT replace it, only `--no-config` does; scope every mocha invocation with `--no-config --require src/test/setup.js --ui tdd <file>`). The hourly RSS-cap restart of the server is expected, not a defect. Forks bypass the burn gate by design. `trddgrep move` performs a real `git mv` and stamps the OS account's username into the card's approval log — so board-column commits happen only when no other worker is mid-move on the same corpus, and the staged diff is grepped for identities before committing. Run `trddgrep validate` before every board commit. Every worker's claim in a report is second-hand until this orchestrating session reads the evidence itself. A shell redirect into a variable path such as `> $S/x` arms the review gate even under the scratchpad: write literal paths.









## Why

The board held 142 open cards, many stale against a rewritten review gate; a program card keeps the order, the plan and the owner's decisions durable across /clear and compaction.


## Correction 2026-09-24T09:11:28+0200

Commit fd4b679a overstated "every open card" and "verdicts re-checked": backburner (15 cards) was NOT covered by the first triage pass -- a backburner triage is running separately now. And "verdicts re-checked" overclaims what actually happened: AI-review verdicts were RE-READ and their cited implementation SHAs were checked by workers; the orchestrator (this session) independently verified only ONE fact itself -- that commit 268f3080 deleted src/cli/reviewGateEffects.ts and its test, the basis for superseding the review-gate cluster. Everything else rests on worker-reported checks, not orchestrator-verified ones. See the STATE block above (rewritten this pass) for the corrected commit range (cf46888e through 8f9fb461, not ".."), the withdrawn NDKKOABG push claim, the owner decisions (ALL STILL PENDING; the STATE of 84ecfed5 and later supersedes this section), 3U8AIHXK's Gen-2 supersession, the stale-approval check (finished: 14 hold, 2 sent to dev) on the ai_review->human_review moves, 4BZPAQWM moved to the front of phase 3, current disk state (97% used, 61 GB free, rust-core/target 21 GB), and that session's spend cap (session-scoped, void after /clear) (12 more worker launches, or stop at 80% of the 5h window).
