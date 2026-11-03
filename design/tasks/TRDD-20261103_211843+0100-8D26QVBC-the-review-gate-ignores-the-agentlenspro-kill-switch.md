---
trdd-id: 8D26QVBC
title: The review gate ignores the AgentlensPro kill-switch
column: ai_review
status: tasked
created: 2026-11-03T21:18:43+0100
updated: 2026-11-03T21:18:43+0100
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
