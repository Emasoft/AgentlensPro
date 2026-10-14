---
trdd-id: YL3EWT6N
title: agentlenspro detects and reinstalls missing or outdated hooks skills agents and rules in user scope
column: dev
status: tasked
created: 2026-10-14T16:43:38+0200
updated: 2026-10-14T16:44:40+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T16:43:38+0200
implementation-commits: [ab5b1274]
---

# agentlenspro detects and reinstalls missing or outdated hooks skills agents and rules in user scope

## Approval log

- 2026-10-14T16:43:38+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Owner request

2026-10-14, owner verbatim: "will agentlenspro install the updated hooks if they are missing or outdated? you should add a semver version number to the skills and the agents too, and even to the rules, just to be sure agentlenspro will detect their absence or their outdated version and automatically install or reinstall them into claude user scope when the cli is executed or the server is started." Also: "note that agentlenspro is not a plugin, but a tool."

## Plan (revision 2, two review rounds)

1. DONE ab5b1274 — drift checks read INSTALLED_EVENTS (supervisor/delegate events were missing; a missing UserPromptSubmit key was never repaired). CHANGELOG at release: the review-supervisor's UserPromptSubmit registration is now restored when missing.
2. IN DEV — skill extra-file drift loop: compare only the shipped relative-path set (evidence docs_dev/20261014_155914+0200-install-selfheal-map.md).
3. TODO — ensureInstalled on server start/restart and daemon start (ensureServer, serverControl.ts:292), same .autosetup.lock (skip+log if held), skipped when Claude Code is absent, honours AGENTLENS_NO_AUTOSETUP / kill-switch / disable; revive unchanged. Tests must fail before the change: server start restores a missing skill; AGENTLENS_NO_AUTOSETUP blocks it; held lock skips with a log line.
4. BLOCKED on owner decisions — edit protection by known shipped hashes (components.lock.json backfilled from every release tag; build fails if the current hash is missing); unknown hash left in place with a warning on implicit triggers; only the explicit setup verb (not first-run auto-setup) backs up and overwrites; known-newer hash follows the downgrade decision.
5. BLOCKED — versions: skills metadata.version, agents version: frontmatter; guard against the previous release tag (CI must fetch tags; a tag-push run compares with the previous tag); any file change in a skill tree requires its SKILL.md bump.
6. BLOCKED — downgrade policy (owner). 7. TODO — warnings to <dataDir>/autosetup.log, stderr only on exit 0, buffered until exit (no mechanism exists yet).
Owner decisions pending (asked 2026-10-14, no answer yet): (a) agent names keep vs agentlens-* prefix vs stop shipping the generic workers; (b) commit or revert the uncommitted hookInstall.ts AGENT_NAMES hunk; (c) downgrades; (d) dev loop when running from a git checkout; plus whether to ship the review-gate part of turn-protocol-and-review.md as a versioned rule. Review evidence: docs_dev/*measure-versioned-selfheal.md, docs_dev/*measure-selfheal-rev2.md.
