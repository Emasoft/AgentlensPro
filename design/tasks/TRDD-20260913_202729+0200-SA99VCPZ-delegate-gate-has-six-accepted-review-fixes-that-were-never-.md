---
trdd-id: SA99VCPZ
title: delegate-gate has six accepted review fixes that were never applied
column: todo
created: 2026-09-13T20:27:29+0200
updated: 2026-09-13T20:34:06+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T20:27:29+0200
---

# delegate-gate has six accepted review fixes that were never applied

## Approval log

- 2026-09-13T20:27:29+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

The delegate-gate module and its test file are UNTRACKED on disk; the CLI entrypoint and the hook-install module carry uncommitted changes wiring the verb in. Work reached round-3-complete/41-tests-clean and received a pre-commit adversarial verdict of ACCEPT-WITH-FIXES with SIX fixes accepted. Session was cleared before any fix was applied and before anything was committed. The six fixes are described in that session's transcript, summarised in the post-clear handoff, and NOT recorded anywhere a future session reads.

## Symptoms previously suspected (UNVERIFIED -- review hints only, NOT a checklist)

1) resolveTranscript's as-is exception must match the caller's agent_id, or nested subagents get the wrong verdict.
2) A Sonnet test case is vacuous without an assert that note === undefined.
3) The NotebookEdit payload field is notebook underscore path, so every Fable NotebookEdit currently denies falsely.
4) One incorrect comment.
5-6) Two further fixes were accepted but are not named anywhere in the handoff or this card -- exactly why the fresh review is the acceptance path, not this list. Applying items 1-4 above does NOT close this card.

## Why not urgent

Measured 2026-09-13: the delegate-gate CLI verb is registered in NO settings file (0 occurrences). The active enforcement is the interim Python hook (1 occurrence in user settings). The verb ships as inert code -- nothing invokes it.

## Why not safe to forget

The hook-install module's rebuildEventMatchers function now pushes the delegate-gate matcher UNCONDITIONALLY, so anyone running the install-hooks CLI command registers the delegate gate and activates it -- with the six fixes still unapplied, alongside the Python hook already doing the job. That is the trigger to guard against.

## Acceptance

THE SIX FIXES ARE NOT RECOVERABLE AS A LIST. Treat src/cli/delegateGate (ts) as UNREVIEWED and give it a fresh adversarial review; apply what that finds; gate it; commit it. Reading the old transcript, if it still exists, is an optimisation -- never the acceptance path. This card closes when src/cli/delegateGate (ts) has passed a fresh review and is committed, OR the delegate-gate is deliberately abandoned and its files removed.
Paths: src/cli/delegateGate (ts, untracked) and src/test/delegateGate.test (ts, untracked); src/cli/main (ts) and src/cli/hookInstall (ts) carry the tracked, uncommitted wiring. hookInstall (ts) is gaining a DELEGATE_GATE_ENABLED registration guard so agentlenspro setup / --install-hooks cannot activate the gate while this card is open; flipping it to true is part of closing this card.
