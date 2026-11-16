---
trdd-id: 9YWTNFU8
title: Refine the review gate without changing its mechanism
column: complete
status: archived
created: 2026-10-09T22:46:57+0200
updated: 2026-11-16T23:04:55+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-09T22:46:57+0200
implementation-commits: [a189abf4, a00d0aff, cba2de2b, 0b51ab77, ac13cf3a, 90432969, da380f32]
---

# Refine the review gate without changing its mechanism

# Review-gate refinement — spec (2026-10-09)

Scope: `agentlenspro review-gate` / `review-supervisor` (src/cli/reviewGate.ts, reviewGateTriggers.ts,
reviewSupervisor.ts). The mechanism is KEPT: propose -> MEASURE + fork REVIEW -> write -> fork REVIEW.
Only measured waste and one coverage hole are removed.

## Owner decisions (verbatim, 2026-10-09)

> fork reviewers are reusing the cache of the main agent so it costs much less than spawning a new agent and writing new cache. also to make an adversarial review you need to have a knowledge of the files and of the changes already, otherwise you will be forced to read those from disk, wasting money in cache writes. the single turn review should cost much less than any other alternative solution, especially because it only needs to give an opinion on what already has recorded in the context, that is shared with the main agent. what is true is that the measurer, having only to read or at best run simply commands yo get info, can be a fast-worker instead. instructed with a very specific step by step prompt, so no error would be possible. also both the measures and the adversarial reviews must happen before changing the code, when the agent only propose the things to do. because if you first make the changes and read/writes millions of tokens just to discover next that it was a bad decision and something to revert back, you have wasted twice the tokens and the time. the system as i designed it works and saved a lots of tokens and reduced the bugs almost by 90%. so it must be perfected but the badic mechanism must be kept. if the right tools are used (tldr-code skill, fastedit skill, jgrep skill, etc.) the tokens wasted will be even less. And soon a new architecture will be implemented that will improve this system even more. but first complete the refinement  and improve what you can.

Earlier the same day: "use cheap-worker agents and fast-worker agents instead of lean-worker".

## Evidence (audit of 4 sessions, 2026-10-08/09)

- 38 roled spawns (36 REVIEW, 2 MEASURE). Review targets: 17 record-keeping, 10 design, 11 code.
- 27 gate blocks each forced one extra full-context main turn (~14.5M tokens total).
- None of the 11 code reviews had the diff in context; they judged a description.
- Workers (lean/smart/cheap) have no Agent tool, so `agentCannotSpawn` releases them; the main gate
  never arms on a worker's writes. Two Rust fix rounds (2026-10-09 15:15, 16:57) went unreviewed.
- `SP=/tmp/x; cat > $SP/f.py` arms (measured: "redirect into $SP/f.py"); bare `$SP` and a literal
  /tmp path do not. Blocked the auditing session three times.
- Supervisor injected ~80 warnings; its warn level (work>0, forks==0) is a window count, not the
  gate's positional rule.

## Steps (order is binding: 1, 4, 3, 2, 5)

### Step 1 — false triggers (reviewGateTriggers.ts, reviewGate.ts)
- `resolve` in `commandWriteReason`: also resolve `$VAR/suffix` and `${VAR}/suffix` when VAR is in the
  positional literal map (pure-assignment segments only, unchanged). Substitute, then let
  `isEphemeralTarget` do its `path.resolve` + prefix check, so `$SP/../../repo/x` still arms. A suffix
  with a shell metachar still arms (existing rule).
- `toolUseWork` editor branch: use `isNeverGatedTarget` (adds `~/.claude/plans/`).
- `fastedit <write-verb> <file>`: does not arm when its first non-flag argument after the verb is an
  ephemeral target (reports/, *_dev/, /tmp).
- Tests: each abuse case fails closed — `$SP/../..`, literal reassignment to a repo path, assignment in
  a non-pure segment, metachar suffix.

### Step 4 — MEASURE on fast-worker (reviewGate.ts texts, ~/.claude/rules/turn-protocol-and-review.md:18)
- `MEASURE_DEMAND` and the directive name `fast-worker` as the preferred measurer and require the
  spawn prompt to be numbered steps: one assumption per step, the exact command, what to report.
  No call cap. Text only; the gate cannot verify the list shape.

### Step 3 — worker writes reach the main gate (reviewGate.ts)
- At Stop, for every non-roled `Agent` spawn in the scanned tail: find the worker transcript at
  `<dirname(transcript_path)>/<session id>/subagents/agent-*.jsonl` via `toolUseId` in `.meta.json`.
- The worker has RETURNED when the main transcript holds, after the spawn, either a tool_result for
  that tool_use id whose text does not start "Async agent launched", or a task-notification naming it.
- If it returned and `toolUseWork` finds writes in its transcript, that return index is work with
  cause "a worker wrote". Floors apply to it as to any work. A worker still running demands nothing.
- Credit for that work needs a fork REVIEW after the return index AND a Bash tool_use containing
  `git diff` between the return and the fork (in an earlier response, so the fork sees its output).
- Exempt: janitor agents, roled spawns. Unreadable/missing worker file => no demand (stderr line).
- Known limit, documented in code: a spawn older than the 4 MB tail is not scanned.
- Tests: fixture with a worker file; returned+wrote demands; running does not; heartbeat floor before
  the return does not clear it; fork without a prior `git diff` does not credit.

### Step 2 — review-of-a-review chains (reviewGate.ts)
- A RECORD write does not arm when a REVIEW credit precedes it and nothing but record writes sits
  between. Record writes are ONLY:
  - `trddgrep append <id> ...` where `<id>` appears in the crediting REVIEW spawn's prompt;
  - `git add <paths> && git commit ...` in ONE command where every added path is a literal under
    `design/` or `.claude/project/memory/`.
- Everything else keeps arming: `trddgrep edit|set|move|new|fix`, `memgrep *-mem-*`, a bare
  `git commit`, `git commit -a`, a commit whose added paths include anything else.
- Tests must include the laundering sequences: review -> commit of a src/ file arms; review ->
  `trddgrep edit` arms; review -> append to a card not named in the review arms.

### Step 5 — noise (reviewSupervisor.ts, reviewGate.ts)
- On the Stop event only, the `warn` level is silent. The `alarm` levels (gate not registered,
  >= 3 unreviewed) and the UserPromptSubmit behaviour are unchanged.
- `demandText`: keep the demand, the verbatim role line(s), the first-line-marker rule, the
  positional-exit sentence, the sentinel, and the `--directive` pointer; drop the rest.

## Review dispositions (fork review of the proposal, 2026-10-09)

Applied: commit removed from the blanket record class; record class narrowed to append-only on a
card named in the review; worker demand keyed to the RETURN, not the spawn; `git diff` made
checkable; Step 1 bounded; supervisor alarm kept; order 3 before 2, 5 last.
Not applied: a per-file scan cache for worker transcripts (unmeasured need; add if the hook nears
its 30 s timeout).

## Out of scope (owner's new architecture)

Enforcing "proposal before any write" in a PreToolUse hook, and demanding the review at write time
instead of at Stop. Until then, pre-write review rests on the PROPOSAL marker.

## Verification per step

`pnpm run compile-tests`, then from the repo root:
`node_modules/.bin/mocha --no-config --require src/test/setup.js out/test/test/reviewGate*.test.js out/test/test/reviewSupervisor*.test.js`
then `pnpm run check-types` and `pnpm run lint`. After step 5: `node esbuild.js`; the global
`agentlenspro` resolves to this repo's `standalone/cli.js` (measured 2026-10-09).

## Approval log

- 2026-10-09T22:46:57+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:06:56+0200 — column → ai_review by main-agent@agentlenspro.
- 2026-10-10T04:52:27+0200 — column → human_review by main-agent@agentlenspro. all five steps implemented and reviewed per step, live in the bundle, gate suites 253 passing on re-run; owner commissioned the refinement
- 2026-11-16T23:04:55+0100 — COMPLETE by main-agent@agentlenspro. reviewed in the owner's stead per the 2026-11-16 order; four gate test files re-run today, 320 passing.

## Implemented (2026-10-10)

All five steps landed, in the binding order 1, 4, 3, 2, 5: a189abf4 (false triggers), a00d0aff (fast-worker measurer), cba2de2b (a returned worker's code arms the main gate), 0b51ab77 (one card append and one path-limited card commit ride each review), ac13cf3a (record-exemption leaks closed, quieter supervisor, shorter block text).
Gate tests: 253 passing; check-types and lint clean. Bundle rebuilt with node esbuild.js after the last commit (bundle and commit carry the same timestamp, and the three gate source files have no uncommitted diff); the global agentlenspro command resolves to this repo's standalone/cli.js. The live bundle also carries a pre-existing uncommitted src/cli/hookInstall.ts change (three worker agent names added to AGENT_NAMES), so it is not byte-for-byte commit da380f32.
The plan as a whole, and steps 3, 2 and 5 individually, were measured by a fast-worker from a numbered step list and reviewed by a fork before code was written; steps 1 and 4 were covered by the plan-level review only. Every step's real source diff was reviewed by a fork before or at commit. Design changes forced by those reviews: commits stay gated unless path-limited to card folders; the record exemption is one append plus one commit per review; the review credit stays unconditional (no git-diff precondition); the supervisor is silent on Stop only when the gate will demand and the agent can spawn; worker record writes are not demanded at return.
Live evidence 2026-10-10: the refined gate blocked the implementing session when a cheap-worker returned with code, naming the cause 'a worker you spawned wrote files' and asking for git diff first.
Known limits left open: a worker whose return was never recorded (session cleared) is not seen; workers spawned by workers are not scanned; a return outside the 4 MB tail is not seen; recording turns that use trddgrep edit/set/move still arm, so review chains are shortened, not ended; a quoted script that merely mentions a write verb can still arm (fail-closed, left as is).
Not done, by owner decision pending the new architecture: enforcing proposal-before-write in a PreToolUse hook, and demanding the review at write time instead of at Stop.
Still unreviewed and outside this card: the uncommitted Rust changes from the two Step-3 fix rounds of 2026-10-09 (investigator_scan.rs, lib.rs, burnscan_store_parity.rs).
Second live event 2026-10-10: the refined gate falsely blocked on a fast-worker that had only chained trddgrep set/append/move in one Bash command. 90432969 fixed plain chains (commandWriteReasons returns every reason of a command; the worker path drops only builds and card/memory records). Third live event, same day: the next card worker was still reported, because the raw-text nested-shell test matched a QUOTED card sentence mentioning bash -c; that also made the following card commit non-exempt. da380f32 judges nested shells on shell words (unquoted eval, or an unquoted shell name followed by a -c style option), which also closes a leak for path-qualified shells.
Estimates stated in session that are weaker than measured facts: the share of record-only review demands the exemption removes (no past commit used the path-limited form it requires, so on past behaviour it is small until agents adopt the form); and that the step-2 build with the two leaks never ran live (no evidence it ran; not proven).
Pre-existing holes in the main command classifier, measured 2026-10-10 and NOT fixed by this card: a write inside bash -lc '...' (clustered option), inside a script fed by heredoc, in bash script.sh, or in $SHELL -c is invisible to both gates. Needs its own card.
The record exemption for the main agent (one append plus one path-limited card commit per review) is proven by unit tests; its first live use is the commit of this very update.
Verification re-run 2026-10-10T04:5x+0200 on da380f32 (the three gate source files have no uncommitted diff; src/cli/hookInstall.ts still carries its unrelated uncommitted change): compile-tests exit 0; gate and supervisor suites 253 passing, exit 0; check-types exit 0; lint exit 0 (warnings only, not counted). The mocha command in 'Verification per step' FAILS as written (ReferenceError: suite is not defined) because --no-config drops the tdd interface; the working command adds --ui tdd. The classifier holes this card says need their own card are now TRDD-YR1598P5 (backburner), which also carries an unconfirmed observation of a second false-trigger spelling (a redirect into a scratchpad path written as a variable plus a dot suffix). This card has no acceptance checklist; it moves to human_review as implemented, per-step reviewed, live and re-verified, for the owner who commissioned the refinement.

## Acceptance

- [x] Step 1, false triggers (a189abf4)
- [x] Step 4, MEASURE on fast-worker (a00d0aff)
- [x] Step 3, a returned worker's writes arm the main gate (cba2de2b; later fixes 90432969, da380f32)
- [x] Step 2, review-of-a-review chains (0b51ab77)
- [x] Step 5, noise (ac13cf3a)
(Written at closing time by the reviewer from the Steps and Implemented sections; the card had no checklist. Evidence for all five: the seven commits are ancestors of HEAD, and the gate and supervisor unit test files ran on 2026-11-16 with the count given in the review note below.)

## Owner-stead review

2026-11-16 23:04 — REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): ACCEPTED. Re-checked today: all seven implementation commits are ancestors of HEAD; the unit test files reviewGate, reviewGateTriggers, reviewGateHelpExemption and reviewSupervisor ran together with 320 passing, 0 failing; check-types exit 0. NOT re-run: lint, and the live blocking event of 2026-10-10. The known limits listed under Implemented stay open as written. Since this card, the harness review mod took over the per-turn review; this card's gate code is still in the tree.
