---
trdd-id: XZ1HG3GX
title: The copy guard denies a copy whose source is an unresolved shell variable
column: todo
status: tasked
created: 2026-11-19T23:11:44+0100
updated: 2026-11-19T23:16:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:11:44+0100
---

# The copy guard denies a copy whose source is an unresolved shell variable

Branch fix/test-cap-copy-guard (dc1cf6a1, not merged): scripts/deny-oversize-copy.js fails closed, so cp $f dst inside a loop, or a source given by a command substitution, is denied even when small, because a PreToolUse hook cannot evaluate shell variables. Decision (2026-11-19T23:11+0100, main agent, owner said decide yourself): keep fail-closed; the owner rule is 'copy measurement data only through a size check' and the deny message must name scripts/capped-copy.sh as the way through. Next: verify the deny text names capped-copy.sh; if not, add it; merge after v2.34.0; tell the owner the hook needs a Claude Code restart.

## Approval log

- 2026-11-19T23:11:44+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Verification

2026-11-19T23:16+0100: the deny text names the script: deny-oversize-copy.js:48 TAIL 'Copy a sample of at most 4 GB through scripts/capped-copy.sh instead.' and :314 'Write the path literally, or copy through scripts/capped-copy.sh.' Remaining: merge after v2.34.0, then a Claude Code restart.
