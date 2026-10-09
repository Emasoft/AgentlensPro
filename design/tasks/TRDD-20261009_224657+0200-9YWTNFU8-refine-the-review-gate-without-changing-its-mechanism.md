---
trdd-id: 9YWTNFU8
title: Refine the review gate without changing its mechanism
column: dev
status: tasked
created: 2026-10-09T22:46:57+0200
updated: 2026-10-09T22:46:57+0200
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
