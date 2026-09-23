---
trdd-id: J4A9GIJR
title: A PROJECT memory lesson holds raw backspace bytes where its grep regex had word-boundary anchors
column: todo
created: 2026-09-23T22:38:47+0200
updated: 2026-09-23T22:38:47+0200
current-owner: main-session
created-by: main-session
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T22:38:47+0200
---

# A PROJECT memory lesson holds raw backspace bytes where its grep regex had word-boundary anchors

.claude/project/memory/memory-scope-leak-detector-false-positives.md holds 6 raw 0x08 bytes: three in lesson [^1] ATOM-EKU8-MW1I (superseded) and three in the SUPERSEDED BODY copy appended to the valid lesson [^2] ATOM-O1A4-0A2I (a9113816). They stand where the author's regex had \b anchors - commit c33f731e's message records it as grep -E '\b[0-9a-f]{24,}\b|\b[A-Za-z0-9+/]{30,}={0,2}' - so the command both copies recommend matches nothing, and most viewers render it invisibly as a runnable-looking regex.

Fix: a mechanical repair (no fact changes, so lmd/updated stay) replacing each 0x08 with the two characters \b in both copies, citing c33f731e; the write must go through a memgrep verb or the Edit tool (no scripted edit), so first establish which of them can target a control byte.

Second finding, outward: memgrep validate and memgrep lint both pass a page with raw C0 control bytes in a lesson body. That is a lint gap in the janitor's memgrep; filing it on the janitor repo needs the USER's approval (outward-facing).

Acceptance: [ ] command grep -a -c $'\x08' on the page prints 0; [ ] both copies read \b-anchored and memgrep validate/lint stay clean; [ ] the janitor lint gap is either filed (with approval) or recorded as declined. related: [EQCGAVGV].

## Approval log

- 2026-09-23T22:38:47+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
