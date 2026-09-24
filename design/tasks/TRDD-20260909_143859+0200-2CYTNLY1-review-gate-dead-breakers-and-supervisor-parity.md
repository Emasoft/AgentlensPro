---
trdd-id: 2CYTNLY1
title: Delete the review gate's dead breakers and give the supervisor the gate's work definition
column: human_review
created: 2026-09-09T14:38:59+0200
updated: 2026-09-24T08:57:50+0200
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
implementation-commits: [53a30222, 86abd4ef]
---

# Delete the review gate's dead breakers and give the supervisor the gate's work definition

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 04:30

Pulled `todo` → `dev` at 03:49 by the janitor keep-going resume, after TRDD-3U8AIHXK reached
`testing`. The §Scope line numbers date from 2026-09-09 and are STALE since 3f498995 (the
attribution scanner grew `reviewGate.ts` by ~110 lines) — navigate by SYMBOL. Re-anchored 03:49
in `src/cli/reviewGate.ts`: `isNoReviewSentinel` :320; `MAIN_MAX_PER_SESSION_DEFAULT` /
`MAIN_MAX_CONSECUTIVE` :414-415; `mainGateMaxPerSession` :420 (EXPORTED — grep every caller
before deleting); `decideMainGate` :585 (`void opts` :615); `mainStatePath` / `readMainState` /
`writeMainState` :619-629; `mainBlockReason` :648; `runMainGate` state plumbing :694-701;
`SUBAGENT_MAX_DEMANDS_PER_AGENT` :718; the subagent exact-match fork check :767;
`decideSubagentGate` params :782-785 (`void` :809); `subagentStatePath` / `readSubagentState` /
`writeSubagentState` :814-821; `runSubagentGate` plumbing :854-868; the silent kill-switch return
:887. `src/cli/reviewSupervisor.ts`: `EDITORS` :26, `scanSupervision` :39, fork exact-match :52,
the `git commit` regex :54. The three gate test files now hold 107 cases (89 when §Acceptance
was written) — that row's count is superseded, the "still pass" clause stands. Delegated to one
lean-worker at 03:49 against this card. The owner's kill-switch question (§Scope, last bullet)
stays OPEN in `## Approval log`; the stderr line ships regardless. BRIEF AMENDMENTS (adversarial
review 03:53, sent to the worker, binding over §Scope where they differ): sentinel floor =
`reason.trim().length >= 8`, no space rule — the block message's own examples ("rate-limited",
"at a depth limit", "tool denied") live in ONE exported constant shared by message and test, all
three must pass and `foo` fail; `scanSupervision` takes `cwd` from the hook payload (never
`process.cwd()`) because `commandWriteReason` needs it, gains a `text`-block branch for
`textArms`, and counts an `isNoReviewSentinel` text as a review; the block message becomes
"<cause + detail> landed after the last review fork (scanned: the transcript's last 4 MB)" — the
gate measures after-the-fork, not a window; the parity test also asserts `commandWriteReason`
on the `sed -i` command is non-null and the `PROPOSAL` block starts a line; `demands` /
`nextDemands` go with the voided params and the two comments describing them are rewritten;
`AGENTLENS_REVIEW_FORK_MAX` grepped across skills/docs/scripts before the exported
`mainGateMaxPerSession` is deleted; the kill-switch stderr line names which HALF fired and never
says "disabled by the owner".
LANDED as `53a30222` (worker report `reports/review-gate/20260910_040630+0200-2CYTNLY1-worker.md`;
diff verified first-hand against all seven amendments; my own chain: tsc / check-types / eslint /
check-mirrors / check-identities 0, the six suites 145 passing + 8 failing under a SCRATCH outDir
and 23/23 for those same 8 from the project `out/` — the runner test resolves REPO_ROOT three dirs
up from its compiled location, so a scratch outDir is the wrong harness for it; the kill-switch
LIFTED case also passed from `out/` — mechanism not established; none of the 8 reproduced there).
Post-write adversarial review of that commit —
three findings, all accepted, plus the reviewed follow-up, delegated to a second lean-worker in
the same turn as this STATE edit, as AMENDMENT 8: (i)
`mainBlockReason` appends "(scanned: the transcript's last 4 MB)" to EVERY cause, but the
`'unreviewed change'` cause comes from the mtime walk in `unreviewedEffects`, not the transcript
tail — name the window per cause (disk: files newer than the last fork; transcript: last 4 MB),
test both; (ii) neither case-fold (scanSubagentTranscriptLines, scanSupervision) has a test —
reverting either passes 130/130; add one `subagent_type: 'Fork'` case per scanner and prove the
mutation; (iii) the gate's stderr line duplicates `=== '1'` from `killSwitch.ts` — export ONE
`killSwitchHalf()` there, used by `agentlensDisabled()` and the gate; (iv) as its OWN commit:
`decideMainGate(scan)` → `{ block }`, `MainBreakerState`/`state`/`nextState` deleted (consumed only
by the tmpdir persistence 53a30222 removed), the "no give-up" test titles KEPT with `block === true`
so a reintroduced breaker still has a named test to break. `scripts/stop-spawn-review-fork.js`
still reads `AGENTLENS_REVIEW_FORK_MAX` — a separate legacy script, out of scope, not deleted.
AMENDMENT 8 LANDED as `86abd4ef` — ONE commit, not two: the group-B hunks interleave with group A
in `reviewGate.ts` and its test and this harness has no interactive staging (deviation from the
review's "own commit"; the message separates the four items). Verified first-hand:
`killSwitchHalf` is the single truth (env precedence pinned by a test), the window text is per
cause with a negative assertion on the disk cause, both case-fold tests present,
`decideMainGate(scan)` with the no-give-up titles kept; my chain 133/133 (four gate/supervisor
suites, scratch outDir) + 24/24 (runner + kill-switch from `out/`), tsc / check-types / eslint /
check-mirrors / check-identities 0. The kill-switch test's end state is cleared by the suite's own
setup/teardown (both delete the env and disarm the flag). Worker 2 self-reported one Python
one-liner batch edit before switching to the Edit tool (rule slip, result diff-verified) — the
same class as worker 1's. DEPLOYED: `node esbuild.js` exit 0 at 04:24, `standalone/cli.js` carries
`killSwitchHalf` (3 hits), the disk-window text (1) and no `agentlens-review-fork-` state name
(0); the bare `agentlenspro review-gate --directive` runs (exit 0) but its directive text is
unchanged by this card, so the bundle greps are the discriminator. Column →
`testing`; the owner's kill-switch question stays OPEN in `## Approval log`.
LIVE (the Stop before 04:30:05, under the `86abd4ef` bundle): this session's Stop was blocked with
"left unreviewed changes on disk: rust-core/crates/agentlens-core/src/burn/agent_gate.rs landed
after the last review fork (scanned: files on disk newer than that fork)" — attributed to the
TRDD-0D6QK5CW worker (sole agent THIS SESSION briefed on that file; inferred, not observed), i.e. the DISK cause
naming the disk window, not the transcript one. Peer session tldr-code-5c told `standalone/cli.js`
changed (message cf2d661d-5181-425a-8944-f49cca63ad64). Column → `ai_review`.
NEXT ACTION: `ai_review` — the owner's kill-switch question (`## Approval log`) is the one open
item; the transcript-cause wording has an in-file test but no live observation yet.

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

- **DECISION — does the GLOBAL kill switch outrank a gate the owner ordered undisablable?**
  `agentlensDisabled()` (`src/cli/killSwitch.ts:92-95`, verified 2026-09-09: env
  `AGENTLENS_DISABLED=1` OR the flag file exists) returns `runReviewGate` at
  `src/cli/reviewGate.ts:796` with no stderr line. The gate already refuses its OWN off-switch:
  `AGENTLENS_REVIEW_FORK=off` is read and ignored with a stderr line (`reviewGate.ts:804-805`,
  owner order 2026-09-03 — an env var is settable by anything in the process tree). The env half
  of the global switch is that same bypass shape. `killSwitch.ts:30` says the switch "is armed by
  an explicit human act" — a claim about the whole switch that its own env branch (`:93`)
  contradicts, so that comment does not by itself support a file-vs-env split; the gate's
  env-switch precedent does. Ship regardless of the decision: a stderr line on the kill-switch
  return, matching the four other silent-allow lines (`reviewGate.ts:588,593,809,819`, re-verified
  2026-09-10). The one question
  for the owner: should the gate honour only the FILE half of the global switch and ignore
  `AGENTLENS_DISABLED=1` the way it ignores its own env switch? Record the answer in
  `## Approval log`; do not decide it in code.

## Acceptance

- [x] `pnpm run check-types` and `npx eslint src/cli/reviewGate.ts src/cli/reviewSupervisor.ts src/cli/killSwitch.ts --quiet` both exit 0 (run at 53a30222 and 86abd4ef).
- [x] The three existing review-gate mocha files (`src/test/reviewGate.test.ts`,
      `src/test/reviewGateTriggers.test.ts`, `src/test/reviewGateEffects.test.ts`) still pass —
      107 `test(` cases in those three as of 3f498995 (89 when this row was written); also run
      `reviewSupervisor.test.ts` (20), `reviewSupervisorRunner.test.ts` (7) and
      `killSwitch.test.ts` (16), counted 03:54 by grep, not by a mocha run. Run at 86abd4ef:
      133 passing across the four gate/supervisor suites (scratch outDir), 24 passing for runner +
      kill-switch from the project `out/` (the runner resolves REPO_ROOT from its compiled path).
- [x] One new `reviewSupervisor.test.ts` case proves `scanSupervision` now counts a `sed -i`
      command and a `git push` command as work — parity with the gate's own `commandWriteReason`
      — on a fixture turn neither the old regex nor the old `EDITORS` set would have caught.
- [x] No behaviour change to the gate's block/allow decision on the existing test corpus — this
      is dead-code removal and a supervisor parity fix, not a new enforcement rule.
- [x] The kill-switch stderr line lands (item 1), asserted by a mocha case that captures
      `process.stderr.write` under `AGENTLENS_DISABLED=1` — on screen it is debug-log only, since
      a Stop hook's stderr on exit 0 is not surfaced to the model or the user (INFERRED from the
      hooks contract, not measured); item 2 stays an open question recorded in this card's
      `## Approval log` once the owner answers, not silently resolved in code.

## Approval log

- 2026-09-10T03:49:54+0200 — OPEN QUESTION for the owner, not decided in code: should the gate
  honour only the FILE half of the global kill switch and ignore `AGENTLENS_DISABLED=1`, the way
  it already ignores its own `AGENTLENS_REVIEW_FORK=off`? Until answered the gate keeps honouring
  both halves, now with a stderr line on that return.
- 2026-09-24T08:57:33+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.

## Notes and lessons learned

- (none yet)
Owed runs 2026-09-23T13:16:38+0200: pnpm run check-types -> exit=0 (settles Box1's 'not re-run, cannot execute pnpm'); npx mocha (scoped config, no full-suite spec) out/test/test/reviewGate.test.js out/test/test/reviewGateEffects.test.js out/test/test/reviewGateTriggers.test.js out/test/test/reviewSupervisor.test.js -> 134 passing (reviewGate*, three files) + 27 passing (reviewSupervisor) = 161 passing, 0 failing, exit=0 (partially settles Box2's 'not re-run'; killSwitch.test.ts and reviewSupervisorRunner.test.ts were not in this task's authorized file list and were not run).

## AI-REVIEW VERDICT
Box1 (check-types/eslint exit 0 at 53a30222/86abd4ef): not re-run by this review — cannot execute pnpm; STATE's own claim is the only source.
Box2 (existing suites still pass): not re-run; code shape at HEAD (src/cli/reviewGate.ts, src/cli/reviewSupervisor.ts) matches the described refactor.
Box3 (scanSupervision parity, sed -i/git push/PROPOSAL): met, VERIFIED. src/cli/reviewSupervisor.ts:23,51-93 imports and calls toolUseWork/textArms/isNoReviewSentinel from reviewGate.ts, takes cwd from the hook (line 51), and src/test/reviewSupervisor.test.ts:63-73 holds the sed-parity test.
Box4 (no behaviour change, dead-code removal only): met, VERIFIED by inspection. src/cli/reviewGate.ts's decideMainGate/decideSubagentGate, tmpdir state files, SUBAGENT_MAX_DEMANDS_PER_AGENT and mainGateMaxPerSession are gone at HEAD, replaced by one decideGate(scan) at reviewGate.ts:490-505; no re-run of the parity test to reconfirm 0 behaviour drift.
Box5 (kill-switch stderr line, per killSwitchHalf): met, VERIFIED. src/cli/killSwitch.ts:84-96 defines the single killSwitchHalf(); src/cli/reviewGate.ts:330-336 uses it for the stderr line, never says disabled by the owner.
Finding: the sentinel floor (isNoReviewSentinel, src/cli/reviewGateTriggers.ts:535-551) is >= 8 chars off NO_REVIEW_SENTINEL_EXAMPLES, matching the Scope requirement; foo (3) fails, the three examples pass — VERIFIED by reading the source.
Finding: at HEAD the per-cause window wording from AMENDMENT 8 (disk vs transcript) is gone because ArmCause (reviewGateTriggers.ts:25) now has only edit/write-shaped command/proposal text — the disk-mtime unreviewed-change cause this card's amendment fixed the wording for was apparently removed by later cards (3U8AIHXK et al.); not a regression this card introduced, but the exact wording this card's Approval log describes no longer exists verbatim in mainBlockReason.
Finding: reviewGateEffects.test.ts named in the box no longer exists (renamed/replaced by reviewLoop.test.ts by later cards) — test-count boxes are stale by construction, not a defect of this card.
The owner's kill-switch question (should the gate honour only the FILE half of AGENTLENS_DISABLED) stays OPEN per instruction — this review does not decide it.
Ready for human_review; the owner makes that move.

## AI-REVIEW VERDICT 2026-09-23T12:55:54+0200 — APPROVE
(verdict body is the section immediately above)

## 2026-09-23 — owed-run note

Recount 2026-09-23T13:23:23+0200: without the stale out/test/test/reviewGateEffects.test.js (source deleted), reviewGate + reviewGateTriggers + reviewSupervisor → 127 passing, 0 failing; the earlier 161 included the stale file.
