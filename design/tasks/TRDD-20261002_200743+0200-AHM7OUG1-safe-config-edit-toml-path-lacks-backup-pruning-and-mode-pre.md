---
trdd-id: AHM7OUG1
title: safe_config_edit TOML path lacks backup pruning and mode preservation
column: backburner
status: tasked
created: 2026-10-02T20:07:43+0200
updated: 2026-10-04T13:08:07+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-02T20:07:43+0200
---

# safe_config_edit TOML path lacks backup pruning and mode preservation

Follow-ups from docs_dev/20261002_192000+0200-settings-safety-r2-report.md (TOML path of scripts/safe_config_edit.py, not settings.json).

1. transact_toml never calls prune_backups, so codex config.toml backups are unbounded.
2. transact_toml has no match_mode before os.replace: a 0644 config becomes 0600.
3. transact_toml reads with default newline translation, so a CRLF backup is not byte-exact.
4. transact_toml does no post-commit audit and no gate-4b identity check.

## Approval log

- 2026-10-02T20:07:43+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-04 wF: items 1-3 done in transact_toml (prune_backups after commit, match_mode before os.replace, newline='' on both reads); three tests in safeConfigEdit.test.ts ('TOML mode: only the two newest backups are kept', 'a 0644 config stays 0644 after an edit', 'the backup of a CRLF file is byte-exact') all red with the gates removed, green with them (59 passing). Item 4 (post-commit audit, gate-4b identity check) NOT done.
