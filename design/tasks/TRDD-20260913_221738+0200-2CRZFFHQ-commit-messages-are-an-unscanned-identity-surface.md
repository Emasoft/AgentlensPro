---
trdd-id: 2CRZFFHQ
title: Commit messages are an unscanned identity surface
column: todo
created: 2026-09-13T22:17:38+0200
updated: 2026-09-13T22:17:38+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T22:17:38+0200
---

# Commit messages are an unscanned identity surface

Found 2026-09-13, demonstrated rather than hypothesised.

## The gap

Two identity controls exist and neither covers commit messages:

- the identity checker (check-no-identities) scans tracked and shipped FILES; wired into compile, package and CI.
- the outbound guard (deny-identity-leak-to-github) is a PreToolUse hook covering gh posts — issue, pr, release, gist, discussion.

A commit message is neither a tracked file nor a gh post. It is durable, public once pushed, and effectively immutable.

## The demonstration

Commit 9de6e62e redacted a home-path string that the identity checker rejects in a file — and its own message QUOTES that string while explaining the redaction. The file scanner would have failed on that text; the message passed unexamined because nothing looks at messages.

Harmless in this instance: the value was a synthetic test HOME, no username, no credential. The PATTERN is not harmless. 'Explain the redaction by quoting the thing you redacted' re-introduces the value into permanent history at the exact moment someone believes they are cleaning it up. Had it been a credential, the cleanup commit would have re-leaked it.

Nine commit messages were written in that session. Zero were scanned by anything.

## The fix reuses what exists

Run the existing identity checker over git log for the range being pushed — a pre-push hook, or a CI step on the push range. It is a small change to a script that already exists, not a new system, and the script is already shape-based rather than keyed to specific values, which is what makes it reusable on a different input.

## Adjacent, worth one grep while in the area

The macOS temp-dir hash (the two-character and twenty-eight-character segments under var folders) is derived from the user's UID and is stable per-user per-machine, so it is semi-identifying, and the file scanner does not look for it. It appeared repeatedly in that session's mocha output. Most likely resting places are the session scratchpad and the gitignored reports directory, so tracked files are probably clean — but one grep over tracked files and git log would settle it rather than assume it.

## Acceptance
- [ ] The identity checker runs over commit messages for the push range, in a pre-push hook or in CI.
- [ ] It fails on a message containing a shape the file scanner rejects. Test against 9de6e62e's message, which is a known positive.
- [ ] Decide whether the temp-dir-hash shape belongs in the scanner's pattern set.

## Approval log

- 2026-09-13T22:17:38+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
