---
trdd-id: PV5BIND2
title: The review gate counts a write to a shell-variable target it cannot resolve as consequential work
column: cancelled
status: archived
created: 2026-11-03T21:34:07+0100
updated: 2026-11-03T22:32:59+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T21:34:07+0100
---

# The review gate counts a write to a shell-variable target it cannot resolve as consequential work

## Symptom
A scratchpad write under /private/tmp/claude-<uid>/... (the macOS real path of /tmp) armed the supervisor's "1 change(s) with NO adversarial review fork" warning. Scratch output should not count as work.

## Evidence
One observed case: a scratchpad write under /private/tmp/claude-<uid>/... armed the warning. Hypothesis from the report: the ephemeral-root test matches only /tmp. Checked: src/cli/reviewGateTriggers.ts isEphemeralTarget (lines 166-184) also tests the /private/tmp/ prefix (lines 175 and 182), so that hypothesis does not explain the case. The cause is not yet located.

## Suspected location
src/cli/reviewGateTriggers.ts, isEphemeralTarget (lines 166-184). It is used at line 213 (isRoleScratchTarget), line 541 (Bash command targets) and line 700 (write-target gate). Next step: trace which branch the scratchpad write takes.

## Context
Found while working TRDD-8D26QVBC (the review gate ignores the AgentlensPro kill-switch; fix committed as e09151d0).

## Approval log

- 2026-11-03T21:34:07+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-03T22:32:59+0100 — CANCELLED by main-agent@agentlenspro. works as designed: undecidable shell-variable targets count as writes by the gate directive; /private/tmp is already ephemeral.

## Findings 2026-11-03

✓ VERIFIED with the compiled commandWriteReasons (out/test/cli/reviewGateTriggers.js): `echo a > /private/tmp/claude-501/x/scratchpad/t.txt`, `echo a > /tmp/t.txt` and `fastedit create /private/tmp/claude-501/x/scratchpad/m.txt` all return [] (not a write). So /private/tmp is treated as /tmp, and the original title was wrong.
✓ VERIFIED: a variable assigned in the same command is resolved (`f=/tmp/y.md; echo a > "$f"` and `f=<repo>/reports_dev/x.md; fastedit create "$f"` both return []). A variable the command does not assign cannot be resolved and counts as a write (`echo a > "$S/$T"` returns "redirect into $S/$T"; a bare `fastedit create "$f"` returns "fastedit create").
Both observed cases ($S/$T around 20:4x, and fastedit create "$f" at 21:44) used variables set outside the command. That matches the gate directive: "an undecidable target — a $VAR, a glob, after a `cd` — counts as a write". Works as designed; no code change.
For agents: write scratch output to a literal absolute path, or assign the variable in the same command, and the gate will not count it.
