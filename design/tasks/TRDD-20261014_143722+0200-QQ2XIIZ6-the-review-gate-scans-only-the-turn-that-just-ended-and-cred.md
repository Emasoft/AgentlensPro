---
trdd-id: QQ2XIIZ6
title: The review gate scans only the turn that just ended and credits only non-isolated forks for REVIEW and MEASURE
column: dev
status: tasked
created: 2026-10-14T14:37:22+0200
updated: 2026-10-15T11:45:54+0200
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
STATE 2026-10-14 16:25 (supersedes the RESUME 15:40 IN FLIGHT/OPEN lines above where they differ): OPEN (1) is ANSWERED — the owner reported seeing no review text in the terminal (the card's Follow-ups quote should read 'and  ideally' with two spaces, as the owner typed it). Next step is the mod design in docs_dev/20261014_160036+0200-review-display-mod-api.md; the main-Stop-hook fallback is NOT ruled out (whether a main-session Stop systemMessage renders, and with ANSI colour, is unverified). IN FLIGHT markerOpening loosening LANDED in cd369160. IN FLIGHT rule-file update FAILED: fastedit refused every attempt, ~/.claude/rules/turn-protocol-and-review.md equals its backup, awaiting the owner's choice of write route. OPEN (2) NO REVIEW POSSIBLE escape and OPEN (4) merge to main still stand. Follow-ups line 2 correction: the docs_dev/$(date …) target as the cause of the false positive and the 'self-feeding' generalisation are INFERRED from one occurrence — verify in src/cli/reviewGate.ts before fixing. Commit b4e0e3c7's message attributes the fork-transcript observation to the owner; the owner reported only that no review text appeared.

## Follow-ups

2026-10-14 16:15 — Owner, verbatim: "until now i've seen no review text on the terminal. you should change the text color of the system message in yellow to make it more easy to see. and ideally it should be collapsed by default and expanded when clicked upon." The SubagentStop systemMessage lands in the fork's own transcript, never the main terminal. Investigated fix: a mod at ~/.claude/skills/agentlenspro-review-display/ that reads the fork's answer at turn.complete and redraws its task-notification row in the warning (yellow) colour, compact by default, full on ctrl+o; per-row click only in fullscreen. Evidence: docs_dev/20261014_160036+0200-review-display-mod-api.md. Not yet built.
2026-10-14 16:15 — Gate false positive: a MEASURE fork's report write into the gitignored docs_dev/ (target `docs_dev/$(date …)-….md`, written with fastedit create) demanded a REVIEW, although *_dev/ writes are exempt for the main agent. Each MEASURE thus triggers a fresh REVIEW demand (self-feeding). Fix: exempt worker writes by the static directory prefix of the target, the same rule as the main agent's writes. Found by the review fork on the measure report, 2026-10-14.
2026-10-14 16:50 — the review-display mod, if built, ships as a versioned component of TRDD-YL3EWT6N (agentlenspro installs it into ~/.claude/skills/agentlenspro-review-display/); 'Next step is the mod design' in the 16:25 STATE line means: candidate, pending owner approval and the owner's 'agentlenspro is a tool, not a plugin' constraint.
2026-10-14 — OPEN, affects EVERY caller, role or not (found in the review of df8bfc70, re-checked for 668fc421): shellWords treats an UNQUOTED backtick as a command separator, so a redirect word ends AT the backtick and the span is split off into its own segment. ``echo x > reports/x/`printf ../../src/a.ts` `` therefore reads as a write into `reports/x/` and is exempt, while the shell writes `src/a.ts`. Fix direction: keep a backtick span inside its word as POSIX does, or arm any redirect word that a split-off span follows.
2026-10-14 — Correction to the 668fc421 commit message: its "Tests: 245 passing" was a run of two files (reviewGate.test.js and reviewGateTriggers.test.js), not the full suite.
2026-10-14 — Correction to the d476914a commit message and code comments: `rm -rf reports/$(printf ..)` does NOT remove the project, because `rm` refuses `.` or `..` as an operand's last component. The real case the `..` rule closes is `cp x reports/$(printf ..)` or `mv`, which write into the project root. `tar -xf a -C reports/$(printf ..)` would too, but the gate classifies no `tar` command at all (a separate gap, OPEN). The comments and the test were corrected in the round-2 follow-up of d476914a; the `rm` assertion stays, labelled pinned.
2026-10-14 — Correction to d476914a's claim that the mktemp shape "armed the gate on every run": unverified when written, and not the observed case. The fastedit fork (`ROLE: INVESTIGATE (…)`) wrote through `F=$SP/ingestEndToEnd.test.ts` and `M=$SP/min.ts`, chained literal assignments, not mktemp. Re-judged on the round-2 code, both of its commands still arm with and without a role (`redirect into $F`, `redirect into $M`), because a value holding `$` is dropped from the literal map. OPEN: resolve `F=$SP/x` through SP's recorded literal value to clear that false positive.
2026-10-14 — Correction to d476914a's test counts: "253 passing" and its fail-on-HEAD counts were the worker's run of two files (reviewGate.test.js, reviewGateTriggers.test.js), not the full suite. The round-2 follow-up ran the same two files: 257 passing; 14 of its 18 new arming cases were exempt on d476914a, and the other 4 already armed there (2 pinned cases, 2 relabelled `cp`/`mv` cases).
2026-10-14 — Accepted residual of the role-scratch relaxation, usable by a declared-role worker only. Content rule: a dynamic part whose output is computed rather than spelled (an unassigned or runtime variable, a computed `X=$(…)`, a `for X in …` variable, `$(cat f)`, `$(printf %s%s . .)`) can still expand to `..` or `../`. mktemp exemption: `eval` of an obfuscated name; `source` or `.` of a file; an alias or function named mktemp, or a TMPDIR, set OUTSIDE the command (the shell profile, the agent's environment); and a failed `mktemp -q`, which leaves D empty and is bounded by the one-component rule to a name at the filesystem root.
2026-10-14 — OPEN, found by the gate review of ed0fbd5e: the mktemp exemption counts an assignment that may never run. Examples: a compound-command body on its own line (if/then, while, for, case, a function body), a line after a trailing && or ||, a backslash-newline continuation, a `)` inside double quotes, and an apostrophe in a # comment, which both miscount atTopLevel. The variable then keeps its INHERITED value, not an empty one, so the one-component bound does not help. Reproducer, role-exempt and writing into the project root: `if false; then` / `PWD=$(mktemp -d)` / `fi` / `cp x "$PWD/CLAUDE.md"` (on four lines). The same works with HOME, OLDPWD and CLAUDE_PROJECT_DIR. ed0fbd5e's subject ("surely holds a fresh mktemp dir") overclaims. Proposed fix, awaiting the owner: count an mktemp assignment only at the very START of the command (only whitespace and earlier qualifying mktemp assignments before it), and delete atTopLevel.
2026-10-15 residual: the gate arms on a write verb followed by a dry-run flag (`AIM_PILLAR_ALLOW_WRITE=1 trddgrep --design-dir X fix <ID> --dry-run`, which wrote nothing). Likely the same family (unverified): git clean -n, git add --dry-run, git commit --dry-run, git mv -n. A fix must be an allowlist of verified (tool, verb, flag) triples with the flag in the last command segment, never a blanket --dry-run exemption.

## Notes and lessons learned

2026-10-15: false positive. The Stop gate reported "ran a write-shaped command: trddgrep append" for a turn whose only occurrence of that text was inside the --content argument of a fastedit create into docs_dev (INFERRED: the same turn also ran an earlier fastedit create that failed on unbalanced quoting, where the text may have stood at command position; which of the two the gate classified is untested). Same family as the open shellWords residuals.
2026-10-15: second false positive, INFERRED mechanism: a roled MEASURE fork wrote only a /tmp clone it then removed (cp to $D/cards.duckdb, rm $D), and the parent gate demanded a review for a worker write; the targets go through a variable the gate could not resolve, the same family as the unresolved-variable residual above.
A third occurrence the same turn: the main agent own cp into a mktemp dir under /tmp ($T) armed the gate the same way.
