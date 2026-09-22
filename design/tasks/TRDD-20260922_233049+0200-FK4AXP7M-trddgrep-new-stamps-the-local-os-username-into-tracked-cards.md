---
trdd-id: FK4AXP7M
title: trddgrep new stamps the local OS username into tracked cards and check-identities cannot see it
column: todo
created: 2026-09-22T23:30:49+0200
updated: 2026-09-22T23:30:49+0200
current-owner: agent
created-by: agent
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: agent
approval-datetime: 2026-09-22T23:30:49+0200
---

# trddgrep new stamps the local OS username into tracked cards and check-identities cannot see it

Measured 2026-09-22: 14 of 299 tracked design/ files (git ls-files -- design | wc -l = 299; git grep -l "<the local OS username>" -- design | wc -l = 14) carry the local OS username in frontmatter fields (current-owner, created-by, assignee, approval-judge, and approval-log lines) — e.g. design/tasks/TRDD-20260913_221738+0200-2CRZFFHQ-*.md has current-owner/created-by/assignee/approval-judge all set to it. trddgrep new fills these from the OS user (os.userInfo().username) when no --author/--assignee is given; this card itself was minted with explicit --author/--assignee agent to avoid adding a 15th occurrence. scripts/check-no-identities.js (verified: node scripts/check-no-identities.js exits 0, OK, on the current tree with the 14 files present) is shape-based — it flags emails and absolute home paths carrying a username, never a bare username field — so this leak is invisible to it: repo is public, commit identity is a pseudonym (git config user.name Emasoft), yet the real local OS username sits in plain text in 14 tracked, pushed files. Fix options to DECIDE, not implement here: (1) cards should take a role/session name, never the OS user default — pass --author/--assignee explicitly at every call site, or file an issue against trddgrep upstream (it is a separate project/tool, not part of this repo, so change its default via issue, not a direct edit here); (2) extend check-no-identities.js with a value-free rule that flags the CURRENT machine's os.userInfo().username (derived at check time via os.userInfo(), never hardcoded) appearing in any tracked file; (3) redact the 14 existing cards to '<the local OS username>' (note: git history still retains the original commits either way — owner decision on whether that is acceptable exposure).

## Approval log

- 2026-09-22T23:30:49+0200 — MANDATE issued by agent (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
