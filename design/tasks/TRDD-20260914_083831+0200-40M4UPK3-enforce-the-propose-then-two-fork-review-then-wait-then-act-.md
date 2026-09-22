---
trdd-id: 40M4UPK3
title: Enforce the propose then two-fork review then wait then act loop at PreToolUse
column: dev
created: 2026-09-14T08:38:31+0200
updated: 2026-09-14T08:52:53+0200
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
---

# Enforce the propose then two-fork review then wait then act loop at PreToolUse

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-14

NEXT ACTION: stage 1a is narrowed to the loop core — fixture fix, A2, A4, A5, A7, A8 helper, A9, A10, B6 prefix clause, and tests 1-17 plus the mutation checks; section C moved to TRDD-VESNWRL0; B2 ADD-list, B4 package.json pin and B5 worktree carve-out stay in stage 1a after the core. DEPLOY HOLD: TRDD-YGETIBJS is blocked on this card. GOTCHAS: agent meta.json exists for only about 98% of subagents, so completion binding uses notification tool-use-id, then meta, then the launch agentId; a subagent's "Fork started" launch result carries no id; the code-tool gate blocks cp/grep on .ts source, so read source with tldr or a /tmp .txt copy; a denied tool call is marked by the top-level transcript field toolDenialKind, measured 2026-09-14.

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
