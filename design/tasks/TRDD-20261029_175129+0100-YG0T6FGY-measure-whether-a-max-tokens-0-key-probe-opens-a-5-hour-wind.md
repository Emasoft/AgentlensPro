---
trdd-id: YG0T6FGY
title: Measure whether a max_tokens 0 key probe opens a 5-hour window on an idle account
column: todo
status: tasked
created: 2026-10-29T17:51:29+0100
updated: 2026-10-29T17:51:29+0100
current-owner: main-agent@AgentlensPro
created-by: main-agent@AgentlensPro
task-type: spike
min-approval-requirement: none
assignee: main-agent@AgentlensPro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@AgentlensPro
approval-datetime: 2026-10-29T17:51:29+0100
---

# Measure whether a max_tokens 0 key probe opens a 5-hour window on an idle account

Context: `get_account_status --all` sends one billed max_tokens 0 message to claude-fable-5-1 per owner-supplied CLAUDE_CODE_LONG_OAUTH_KEY_* key, at most once per 10 minutes (src/longOAuthKeys.ts), including while AgentlensPro is disabled. If a probe opens a 5-hour window on an idle account, every keyed idle account starts one on every run, a user-visible cost. `--no-refresh` skips probes.

Method: pick a keyed account whose 5h window is idle (no reset time in its last reading), probe once with `agentlenspro get_account_status --all --json --out <file>`, compare the 5h reset and utilization before and after, and record the measurement.

Outcome: a statement with the measurement; if a probe opens a window, a follow-up to document it in the help text or change the probe.

Relevant code: src/longOAuthKeys.ts. Origin: TRDD-HO94JMKD human review 2026-10-29.

## Approval log

- 2026-10-29T17:51:29+0100 — MANDATE issued by main-agent@AgentlensPro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
