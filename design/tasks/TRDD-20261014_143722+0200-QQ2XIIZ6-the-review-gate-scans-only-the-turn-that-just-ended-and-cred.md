---
trdd-id: QQ2XIIZ6
title: The review gate scans only the turn that just ended and credits only non-isolated forks for REVIEW and MEASURE
column: dev
status: tasked
created: 2026-10-14T14:37:22+0200
updated: 2026-10-14T15:36:39+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T14:37:22+0200
project-id: agentlenspro
---

# The review gate scans only the turn that just ended and credits only non-isolated forks for REVIEW and MEASURE

## Approval log

- 2026-10-14T14:37:22+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-14 — authority is the owner's direct request in the session (quotes Q1-Q3), not a self-issued mandate.
- 2026-10-14 — quotes Q1-Q4 (Q4 added after the first approval line).

## User directives (verbatim, 2026-10-14)

Q1: "the enforce is by checking and only allows to pass the turn if a fork-agent without worktree is been spawned, while dot allowing to pass the turn if a fork-agent with a worktree is spawned instead."
Q2: "- everything written or changed in the previous turn must be used to determine if the turn was worthy of being reviewed. the fork agent is identical to the very agent that did the previous turn, since it is a fork of it, so it remembers everything and possess the full context with all the details. he knows exactly what he did. the measurer is also a waste as it is now. a new agent is spawned, instead of another fork. this waste tokens. instead use a second fork agent for the measurer, like for the reviewer, will costs almost nothing since everything is in cache. only the prompt, plus few short file reads (via tldr-skill), are added to the context"
Q3: "but it is called per-turn review. it should only review the last turn actions. why it is extracting info from 4MB of history?"
Q4: "if the hook decides that the turn is worthy of being reviewed, the hook must block the agent until he spawn a fork agent. it must be forced to do it or it won't go to the next turn."

## Scope and known separate items

Files: src/cli/reviewGate.ts, src/cli/reviewSupervisor.ts, src/test/reviewGate.test.ts, src/test/reviewSupervisor.test.ts; user rule turn-protocol-and-review.md MEASURE row.
Turn start = user entry with origin.kind human (Stop-hook feedback is isMeta and must not start a turn).
Out of scope, separate item: runMainGate ignores stop_hook_active; the 9-consecutive-block cap fired on 2026-10-14.
Pointer (2026-10-14): the out-of-scope item above now lives in TRDD-LR4SI79M (harness 9-consecutive-Stop-block cap overriding the forced review gate).

## Acceptance

- [ ] An Agent spawn with any isolation value earns no REVIEW or MEASURE credit (main and subagent gates).
- [ ] MEASURE credit requires subagent_type fork.
- [ ] Stop-hook feedback (isMeta user entry) does not start a new turn.
- [ ] A write in an earlier turn is not demanded in the next turn.
- [ ] A heartbeat-fired turn (attachment entry) is a turn start; its own writes are demanded, earlier ones are not.
- [ ] The scan reads backward to the turn start; no fixed 4 MB tail.
- [ ] When deployed, rewrite the pending sentence in ~/.claude/rules/turn-protocol-and-review.md in present tense.
- [ ] At deploy, supersede the hook-events-pipeline memory atoms that describe the pre-change gate in the present tense (RJ09 4 MB tail, BDF5 credit predicate without isolation) and refresh their reviewGate.ts / reviewSupervisor.ts line citations.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-14

Implementation in progress in a worker worktree based on checkpoint 4a9e87e9 (branch fix/setup-agent-preflight in the main checkout). OPEN: the turn-start discriminator for heartbeat-fired turns (attachment entries) is not yet confirmed; heartbeat floor detection (isFloorPrompt reads message content) may be inert on attachments. Rule file edited and marked pending.
Turn boundary MEASURED 2026-10-14 (supersedes the Scope line and the heartbeat acceptance wording): a turn starts at a type user entry whose turnPosition is an object and isSidechain is not true; heartbeat prompts are such user entries with turnOrigin scheduled, not attachments; Stop-hook feedback, tool results, /clear and /exit lack turnPosition. Implementation moved to a non-isolated worker in the main checkout (the isolated worktree guard refused fastedit text naming git).
The acceptance box 'Stop-hook feedback does not start a new turn' protects owner Q4 — do not weaken it.
Per-turn scope means a cap override loses the turn's review permanently; see TRDD-LR4SI79M.
Open owner decision: remove the NO REVIEW POSSIBLE text escape? (no box until the owner answers)
Rule-file box means the owner's user-scope rule turn-protocol-and-review.md.
Supersedes the first STATE line: implementation runs in the MAIN checkout (non-isolated worker), and the heartbeat question is settled below.
Orchestrator re-measured 2026-10-14 on the session transcript: all 116 heartbeat prompts are type user entries with an object turnPosition, turnOrigin scheduled and isMeta true; 6 attachment entries also contain the heartbeat text and 4 of them sit mid-turn, so attachments must NOT start a turn and isMeta must NOT exclude one. Turn start = type user && turnPosition object && isSidechain not true.
An abandoned isolated worktree (.claude/worktrees/agent-aacd564da94c0b2ba) holds partial uncommitted reviewGate.ts edits; superseded, not to be merged; keep until this card closes.
Committed 9105ecde and live via the npm link (built before review; two review rounds found no blocker).
Commit-message corrections: the review display is UNCONFIRMED in the terminal — the hook's systemMessage was recorded as hook_system_message in the fork's own transcript and not in the parent's, and the owner has not confirmed seeing it; the 338-test/tsc/eslint figures were worker-reported; mid-turn typed messages were not observed to start a turn (one message, 293 turn starts, one session).
Open: if SubagentStop systemMessage is not shown in the main terminal, emit the review from the main Stop hook of the turn that receives the fork's task-notification.
RESUME 2026-10-14 15:40: branch fix/setup-agent-preflight holds 9105ecde (per-turn gate, fork-only credit, review display via SubagentStop systemMessage) and 12f00588 (unique markers [AGENTLENSPRO-REVIEW-REPORT] / [AGENTLENSPRO-MEASURE-REPORT], defined once in reviewLoop.ts, shared markerOpening). Both are live via the npm link (node esbuild.js); no collector restart was needed because hooks run the CLI.
IN FLIGHT: markerOpening loosening (accept marker followed by any non-word char, fixing **[MARKER]** Task:, backticked marker + text, [MARKER]:) — uncommitted until its review; owner rule file ~/.claude/rules/turn-protocol-and-review.md being updated to the new markers and to say forks return as completion notifications (backup docs_dev/turn-protocol-and-review.md.bak-20261014b).
OPEN: (1) owner has not confirmed whether the review appears in the main terminal — the hook's systemMessage was recorded as hook_system_message only in the fork's own transcript; fallback plan: emit it from the main Stop hook of the turn that receives the fork's task-notification. (2) owner decision pending: remove the NO REVIEW POSSIBLE text escape. (3) memory follow-ups: re-add IJC5's [^1]-[^3] lesson references; drop the 'uncommitted' note in atom 8ZOJ once the markers commit. (4) the branch must be merged to main (--no-ff) before the release work continues.
