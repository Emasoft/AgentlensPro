---
trdd-id: AHM7OUG1
title: safe_config_edit TOML path lacks backup pruning and mode preservation
column: backburner
status: tasked
created: 2026-10-02T20:07:43+0200
updated: 2026-10-04T14:19:49+0200
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
implementation-commits: [e834c93c, d320275c]
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
2026-10-04 follow-up from review: transact_toml wrote replaced/appended lines LF-only into a CRLF file (mixed endings, and a replaced line never compared equal to its own copy); op lines, the new header and the blank separator now carry the file's CR. First creation of a missing file verified: no raise, mode 0600 as the JSON path. A prune_backups failure after commit propagates unguarded exactly as in transact_json (mirrored, unchanged). Tests: 'a CRLF file stays CRLF after an edit', 'first creation of a missing file succeeds with the private 0600 mode'; TOML suite 8 passing.
2026-10-04: items 1-3 landed at e834c93c and d320275c. Still owed by the main agent: item 4 (post-commit audit), and a TOML file with mixed line endings is not handled (the CRLF fix applies CRLF to every written line when any CRLF exists). Not closed.
2026-10-04: mixed-ending TOML fix in scripts/safe_config_edit.py (transact_toml decides line endings per line: compare without own ending, replace keeps the line's ending, append uses the neighbouring line's ending). Tests: 'TOML mode: a mixed-ending file with the op line already present (LF copy) is left byte-identical' and 'a replaced line keeps its own ending in a mixed-ending file' (both red on the old code, 68 passing in mocha --grep TOML|safeConfigEdit after).
