---
trdd-id: 8D26QVBC
title: The review gate ignores the AgentlensPro kill-switch
column: complete
status: archived
created: 2026-11-03T21:18:43+0100
updated: 2026-11-16T22:59:47+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T21:18:43+0100
implementation-commits: [e09151d0]
---

# The review gate ignores the AgentlensPro kill-switch

## Symptom
Since `agentlenspro disable` on 2026-10-27, `agentlenspro review-gate` allowed every Stop and SubagentStop UNREVIEWED, and the review supervisor kept warning. No adversarial review was demanded while the switch was armed.

## Cause
runReviewGate (src/cli/reviewGate.ts) returned early on agentlensDisabled(). The global kill-switch exists to stop side effects, and the review gate has none, so the switch silenced a gate that only reads the transcript.

## Fix
The switch check was removed from runReviewGate. The gate reads the transcript and prints a block to stdout. The suite "reviewGate — runReviewGate: the global kill-switch does not silence the gate" covers both halves of the switch and the DISABLED file alone. The flag-file text, the disable output, the killSwitch.ts header and the README now name the hooks the switch turns off. The review gate and the review supervisor are named as staying on.

## Owner orders (verbatim)
- 2026-09-03: "it must NEVER BE STOPPED OR BYPASSED, no matter what"
- 2026-11-03: "focus on making the adversarial review work again at each turn and for each agent"

## Open owner decision
Should the delegate gate (`agentlenspro delegate-gate`) obey the switch? It has no switch check today. The installer does not register it (hookInstall.ts: registration removed until TRDD-SA99VCPZ closes), so it does not run by default.

## Brake caveats (found in review, not fixed here)
- `agentlenspro --uninstall-hooks` removes the review gate and supervisor registrations (hookInstall.ts isOurHookCommand). It is refused while the switch is armed (main.ts disabledNotice).
- Each running Claude session keeps its hooks until it restarts.
- The next launch of a verb outside AUTOSETUP_EXCLUDED_VERBS re-registers the hooks (autoSetup.ts launch check) unless the switch is armed afterwards.

## Note
The live DISABLED flag file under ~/.agentlens still carries the stale text written on 2026-10-27. It is left for the owner to rewrite.

## Approval log

- 2026-11-03T21:18:43+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-03 — OWNER RULE, verbatim: «the disabled state should never disable the adversarial review hook!» This confirms the direction of e09151d0 (the gate and supervisor ignore both halves of the off switch). Not yet covered: re-installing a missing review hook while the switch is set.
- 2026-11-16T22:59:47+0100 — COMPLETE by main-agent@agentlenspro. reviewed in the owner's stead per the 2026-11-16 order; fix re-checked, open question decided and handed to TRDD-SA99VCPZ.

## Evidence basis

The commit message's claim that the new kill-switch tests fail on the old code rests on code reading (the old runReviewGate returned before reading stdin under either half of the switch), not on a mutation run. To measure it: check out 031a416f in a scratch worktree, copy in the new src/test/reviewGate.test.ts, run compile-tests and mocha, and expect the four kill-switch tests red.
Declined nit: the README 'Emergency stop' sentence has no comma before 'in every Claude Code session already running'; the bold span keeps it parseable.

## Owner-stead review

2026-11-16 22:59 — REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): ACCEPTED. Re-checked today: e09151d0 is an ancestor of HEAD; src/cli/reviewGate.ts has no agentlensDisabled call; the suite named in the Fix section exists in src/test/reviewGate.test.ts and that file ran with 201 passing. NOT run: the mutation described under Evidence basis.
DECISION on the open question (decided by the main agent under the same order; the owner can overrule it): YES, the delegate gate must obey the kill-switch. Reason: it denies tool calls, so a faulty delegate gate needs a brake, and the owner's two never-stop orders name the adversarial review, not the delegate gate. No code changes now, because the gate is not registered (src/cli/delegateGate.ts has no switch check; registration waits on TRDD-SA99VCPZ, column todo). The requirement is recorded on TRDD-SA99VCPZ.

## Acceptance

- [x] runReviewGate no longer returns early when the kill-switch is set (e09151d0; no agentlensDisabled call in src/cli/reviewGate.ts on 2026-11-16)
- [x] a test suite covers both halves of the switch and the DISABLED file alone (src/test/reviewGate.test.ts, 201 passing on 2026-11-16)
(Written at closing time by the reviewer from the Fix section; the card had no checklist.)
