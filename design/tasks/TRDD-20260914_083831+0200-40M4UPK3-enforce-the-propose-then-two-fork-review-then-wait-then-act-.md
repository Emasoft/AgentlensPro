---
trdd-id: 40M4UPK3
title: Enforce the propose then two-fork review then wait then act loop at PreToolUse
column: todo
created: 2026-09-14T08:38:31+0200
updated: 2026-10-16T11:16:05+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: feature
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-14T08:38:31+0200
priority: high
status: tasked
---

# Enforce the propose then two-fork review then wait then act loop at PreToolUse

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-22

NEXT ACTION: stage 1a (spec reports/review-loop-gate/20260914_095303+0200-stage1a-loop-spec.md) is narrowed to the loop core. DONE: fixture marker fix, A2 (c14df0a6), A1 key amendment. REMAINING, in order: A10 (test 13d red — reviewLoop.ts ~644-649 denies on a null parent cycle before resolving the spawner chain; the fix must judge the spawner's standing at the subagent's anchor time, not now, with a negative twin test: a depth-2 worker spawned before the main window opened is denied), A1 anchor (a proposal is a text block whose FIRST non-blank line matches PROPOSAL_LINE, per the turn protocol — the /m regex currently lets any line anywhere open a cycle and close the open window), A1 follow-ups a–f from the round-2 review (Notes), A4, A5, A7, A8 helper, A9, B6 prefix clause, tests 1-17 plus the mutation checks; then B2 ADD-list, B4 package.json pin, B5 worktree carve-out. Section C (gate self-protection) moved to TRDD-VESNWRL0; the write-LOCATION scope rule moved to TRDD-5D0VU5NJ. THEN stage 2: PreToolUse/Stop/SubagentStop integration, supervisor, hook registration, deletion of the old two-role positional code and its tests; then build, install hooks, restart, live checks. DEPLOY HOLD: TRDD-YGETIBJS is blocked on this card. Caveat: the deployed loop gate carries no self-protection guards until TRDD-VESNWRL0 lands — inside an open window an agent could edit settings or hooks to switch it off; outside a window every GATED write is denied (never-gated roots such as /tmp, reports/, *_dev/ still pass). GOTCHAS: agent meta.json exists for only about 98% of subagents, so completion binding uses notification tool-use-id, then meta, then the launch agentId; a subagent's "Fork started" launch result carries no id; the code-tool gate blocks cp/grep on .ts source, so read source with tldr or a /tmp .txt copy; a denied tool call is marked by the top-level transcript field toolDenialKind, measured 2026-09-14. OUT-OF-CORPUS WORK: the owner's user-scope rule propose-then-review-then-implement.md must be updated to the two-fork loop.

## Why
The owner requires every action to follow: the main agent proposes; two FORK agents run (ROLE MEASURE -> MEASURE-AND-VERIFY-REPORT, ROLE REVIEW -> ADVERSARIAL-REVIEW); the main agent waits for both to finish, then acts corrected by both. The committed two-role gate (b08e76aa, 3555741c) is Stop-only, so it enforces act-then-review and cannot enforce waiting; it also credits roles at result index, credits any tool_result, lets any fork move the effects floor, and its subagent gate appears inert (a code read of the sidechain skip plus two sampled subagent files; not yet reproduced by a test).

## Design
A PreToolUse deny gates every write: Edit, Write, NotebookEdit, MultiEdit, Monitor and Bash commands that are write-shaped or run scripts, plus the write actions of Artifact, DesignSync, RemoteTrigger, Workflow and worktree tools. The gate opens only inside a window: after the latest PROPOSAL, two fork agents whose prompts begin ROLE: MEASURE and ROLE: REVIEW and contain the proposal key have completed (harness notification status completed) with their headings in their own transcripts. The window closes at the next PROPOSAL or after 300 allowed gated calls; there is no time cap, and the supervisor warns on windows open longer than 2 hours. Measure and review forks are read-only: explicit writes are denied, and the only runners they may use are an exact-argv list (pnpm run check-types, lint or compile-tests; npx tsc --noEmit; npx eslint on src paths; npx mocha on out/test files). Workers spawned inside a window inherit it until they return. Only the janitor dispatcher stub and the janitor arm scripts are exempt from the runner rule; agentlenspro disable, enable and --uninstall-hooks, and edits that remove the review-gate registrations, are denied even inside a window. A NO-REVIEW-POSSIBLE sentinel is the only exit when a fork cannot be spawned. Stop and SubagentStop keep a launch check (a proposal must be followed by both spawns) and backstops for tool writes and on-disk effects outside windows. The subagent gate is fixed to read its own transcript entries, which are all isSidechain true.

## Supersedes
TRDD-1YXR6S47, TRDD-BA0DCW98, TRDD-4J1QA18G - their code paths will be deleted by this redesign. TRDD-YGETIBJS (deploy) completes when this card passes live acceptance.

## Acceptance
- [ ] stage 1 tests (plan tests 1–15, 18–20, 22) passing with mutation checks on 1, 4, 7, 13, 19
- [ ] stage 2 tests 16, 17, 21 passing and the old positional-gate tests deleted or rewritten
- [ ] check-types exit 0, lint 0 errors, review-gate and supervisor tests all passing, full unit suite no new failures versus the 2026-09-14 baseline (2833 pass, 5 unrelated failures)
- [ ] deployed with a verified bundle symbol, install-hooks showing the PreToolUse entry, server restarted
- [ ] live: an edit with no proposal is denied, an edit while both forks run is denied, an edit after both headed completions is allowed, Stop after a proposal without spawns blocks, the janitor stub still runs, review-gate --directive describes the loop
- [ ] superseded cards carry superseded-by 40M4UPK3; docs and memory swept for single-fork statements
- [ ] commits by name

## Approval log

- 2026-09-14T08:38:31+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-14 — APPROVED by emanuelesabetta: the implementation plan was approved in session via plan-mode approval. The earlier MANDATE line named a placeholder issuer.
- 2026-10-16T11:13:13+0200 — column → todo by main-agent@agentlenspro. work stalled mid-way or never started; no one works it now; triage row 31

## Notes

Amendment A1' (2026-09-22): the marker `PROPOSAL FOR ACTION - PLEASE REVIEW` is a CONSTANT string, so a key derived from the marker line itself (the original A1 rule) is identical for every proposal and cannot bind a spawn to its own proposal. The key is now the first 160 normalised chars of the proposal's CONTENT (the remainder of the marker line plus every following line), with no short-first-line shortcut (a templated opener would collapse the key back toward a constant). A marker with no content normalises to an empty key, which can never bind a spawn (scanCycles guards on key !== ''), and missingReasonOf reports it as 'key-missing'. Full text: reports/review-loop-gate/20260914_095303+0200-stage1a-loop-spec.md, section "Amendment A1'".
Round-2 review findings for round 3 (2026-09-22): (a) a spawned fork whose prompt does not contain the proposal's key is reported as 'role-not-spawned' although it WAS spawned -- once wired, that wrong reason invites re-spawning (the token-draining loop the owner stopped on 2026-09-15); add a distinct reason telling the agent to paste the proposal verbatim. (b) the A1' test 'two proposals sharing the same first content line' places P1's spawns BEFORE P2, so position alone excludes them from cycle 2 and the test only fails on key equality -- add the real binding test: after P2, a fork quoting P1 must not credit cycle 2 while one quoting P2 does. (c) a content-reflow test (re-wrapped/re-indented pasted proposal still binds) was requested and not added. (d) two proposals sharing >160 chars of opening text still collide, and very short content gives a weak key -- decide a minimum content length or a longer/whole-content key. (e) the markerIndex === -1 fallback in proposalKey is unreachable and would return the old marker-derived key -- delete it or return ''. (f) for a body-less proposal the message prints key "" -- drop the key there.
2026-09-24T08:56:26+0200 — from superseded TRDD-WAW0M092 (mechanism deleted, Gen-2 mtime arm): (a) batch writes into fewer turns halves fork count — cheap, orthogonal, still true under Gen 3/4; (b) copy-rename lost-update-race objection — worth remembering if any future design reintroduces atomic-landing.
2026-09-24: stage 2 must reuse declaredRole / declaredRoleOwnTranscript from src/cli/reviewGate.ts rather than re-deriving its own marker regex -- reviewSupervisor.ts already does this correctly (imports declaredRole, uses it at line 86), confirmed while working TRDD-BA0DCW98's directive/supervisor-parity pass; follow that precedent.
2026-10-16: moved to todo by the board triage (row 31). What remains: A red test and the rest of the stage list.
