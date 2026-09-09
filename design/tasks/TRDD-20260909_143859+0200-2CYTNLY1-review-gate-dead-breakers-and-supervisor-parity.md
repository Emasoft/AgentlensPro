---
trdd-id: 2CYTNLY1
title: Delete the review gate's dead breakers and give the supervisor the gate's work definition
column: todo
created: 2026-09-09T14:38:59+0200
updated: 2026-09-09T14:38:59+0200
current-owner: main
task-type: refactor
priority: medium
severity: low
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [review-gate, hooks, refactor]
related: [9FG0LSPG, 0E3W5C45]
blocked-by: []
npt: []
eht: []
implementation-commits: []
---

# Delete the review gate's dead breakers and give the supervisor the gate's work definition

## Why

TRDD-9FG0LSPG's §Why listed eight defects; this is items 6, 7 and 8 of that list, filed as its
promised Phase 2 EHT. Two of the original eight are already DONE in `208994b8` and are NOT
carried forward here: the case-folded fork check landed only for `scanMainTranscriptLines`
(`src/cli/reviewGate.ts:459`), and the `stop_hook_active` interface comment
(`src/cli/reviewGate.ts:121-127`) now correctly states the main gate does not honour the field —
verified against the live source, not restated from memory.

## Scope

- **Two sources of truth for "did work happen".** `reviewSupervisor.ts::scanSupervision`
  (`src/cli/reviewSupervisor.ts:39-58`) reuses neither `toolUseWork` nor `textArms` from the gate
  — it re-derives work from its own `EDITORS` set (line 26) plus a bare `/\bgit\s+commit\b/` regex
  (line 54), so it is silent on `sed -i` / `git push` / every other write-shaped Bash command the
  gate's `commandWriteReason` (`reviewGateTriggers.ts`, imported by `reviewGate.ts:17`) already
  recognizes, and on a marked `PROPOSAL` text arm (`textArms`, same import). Make
  `scanSupervision` call `toolUseWork`/`textArms` instead of re-implementing the predicate.

- **Case-fold the two fork checks the gate's own comment claims are already folded but aren't.**
  `scanSubagentTranscriptLines` (`src/cli/reviewGate.ts:676`: `b.input?.subagent_type === 'fork'`)
  and `reviewSupervisor.ts::scanSupervision` (`src/cli/reviewSupervisor.ts:52`: same exact-match)
  both compare case-sensitively, while `scanMainTranscriptLines`
  (`src/cli/reviewGate.ts:459`: `.trim().toLowerCase() === 'fork'`) is folded. Fold both to match.

- **Delete the dead breaker plumbing in `reviewGate.ts`** — every one of these is read, then
  voided, and decides nothing:
  - `decideMainGate`'s `opts` parameter (`:497`, `:524` `void opts`) and its two constants,
    `MAIN_MAX_PER_SESSION_DEFAULT` / `MAIN_MAX_CONSECUTIVE` (`:369-370`).
  - `mainGateMaxPerSession()` (`:375-378`) and the `AGENTLENS_REVIEW_FORK_MAX` env read inside it
    — its return value is only ever passed into the now-void `opts`.
  - `decideSubagentGate`'s `enforceOn` / `maxDemands` parameters (`:691-692`, `:718` `void
    enforceOn; void maxDemands`) and `SUBAGENT_MAX_DEMANDS_PER_AGENT` (`:627`); `runSubagentGate`
    hardcodes `enforceOn = true` (`:763`) right next to the dead parameter it feeds.
  - The tmpdir state files, kept "for observability only" (`:606`, `:775`) and read back nowhere
    else in the codebase: `mainStatePath`/`readMainState`/`writeMainState` (`:528-540`) and
    `subagentStatePath`/`readSubagentState`/`writeSubagentState` (`:723-732`), plus their call
    sites in `runMainGate` (`:602-610`) and `runSubagentGate` (`:770-777`). Delete the files and
    the writes; nothing in this repo's tests or code reads `agentlens-review-fork-*.json` /
    `agentlens-subagent-review-*.json` back.

- **The no-review sentinel's reason floor is too low.** `isNoReviewSentinel`
  (`src/cli/reviewGate.ts:313-329`) accepts any reason `>= 3` characters (`:328`) — `"foo"`
  passes. Raise the floor or require the reason read as a sentence (own judgement call: the
  parent card's mutation-test discipline applies — pick a bound with a test proving both the
  new floor blocks a garbage reason and still passes a real one).

- **The block message overclaims its own window.** `mainBlockReason`
  (`src/cli/reviewGate.ts:557-560`) says `Review-fork gate: this turn ...`, but the scan is over
  `readTranscriptTail`'s last `4 * 1024 * 1024` bytes (`:381`), not "this turn" — a long turn's
  earlier blocks are outside the window and the wording claims certainty the scan does not have.
  Reword to name the scanned window, matching `reviewSupervisor.ts`'s own care about this exact
  overclaim (`:108-109`, "in the scanned window, never 'this session'").

- **DECISION — the kill switch silently disarms a gate the owner ordered undisablable.**
  `agentlensDisabled()` (`src/cli/killSwitch.ts:92-95`) is checked at the top of
  `runReviewGate` (`src/cli/reviewGate.ts:796`: `if (agentlensDisabled()) return 0`) with no
  stderr line at all — the file's own doctrine (`killSwitch.ts:28-31`) says the switch is meant
  to stop *every* AgentlensPro side-effect, but the standing order in `reviewGate.ts:108`
  ("This gate CANNOT be disabled") and the `never-disarm-the-janitor`-shaped memory
  `review-fork-gate-never-disabled.md` both say the review gate specifically is never to be
  disabled by anything. Two open questions for the owner, not decided here: (1) minimum fix —
  add the stderr line every other silent-allow path already has (`reviewGate.ts:588,593,809,819`
  are the precedent); (2) larger question — should the global kill switch be allowed to cover the
  review gate at all, or should the gate check `AGENTLENS_DISABLED`/the flag file itself and
  refuse to honour it (mirroring how `reviveBraked()` is deliberately NOT unified with
  `agentlensDisabled()`, `killSwitch.ts:56-61`)? Do not pick an answer in code before the owner
  rules on (2); ship (1) regardless.

## Acceptance

- [ ] `pnpm run check-types` and `npx eslint src/cli/reviewGate.ts src/cli/reviewSupervisor.ts src/cli/killSwitch.ts --quiet` both exit 0.
- [ ] The three existing review-gate mocha files (`src/test/reviewGate.test.ts`,
      `src/test/reviewGateTriggers.test.ts`, `src/test/reviewGateEffects.test.ts`) still pass, 89/89.
- [ ] One new `reviewSupervisor.test.ts` case proves `scanSupervision` now counts a `sed -i`
      command and a `git push` command as work — parity with the gate's own `commandWriteReason`
      — on a fixture turn neither the old regex nor the old `EDITORS` set would have caught.
- [ ] No behaviour change to the gate's block/allow decision on the existing test corpus — this
      is dead-code removal and a supervisor parity fix, not a new enforcement rule.
- [ ] The kill-switch stderr line lands (item 1); item 2 stays an open question recorded in this
      card's `## Approval log` once the owner answers, not silently resolved in code.

## Notes and lessons learned

- (none yet)
