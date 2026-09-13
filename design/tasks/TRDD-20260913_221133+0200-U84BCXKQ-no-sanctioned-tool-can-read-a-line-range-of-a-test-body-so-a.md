---
trdd-id: U84BCXKQ
title: No sanctioned tool can read a line range of a test body so assertions cannot be verified
column: todo
created: 2026-09-13T22:11:33+0200
updated: 2026-09-13T22:11:33+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: infra
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-13T22:11:33+0200
---

# No sanctioned tool can read a line range of a test body so assertions cannot be verified

Found 2026-09-13 while trying to discharge a read-debt on committed code. This BLOCKS the open verification item on TRDD-4J1QA18G and will cost any future session that tries the same thing.

## The gap

To confirm that a named test actually guards what its name claims, you must read its ASSERTION. Every sanctioned route was tried and every one failed:

- git diff / git show on a source file — DENIED by code_tool_gate (prints source contents)
- grep / cat / sed / head on a source file — DENIED by the same hook
- the Read tool on a tldr-parsable file — gated
- tldr slice FILE FUNCTION LINE — 'Function not found' on test blocks, because tldr names them as kind 'call' with synthetic names like test:returned-agents-must-leave, and slice resolves real function symbols only
- tldr context ENTRY PATH — takes an entry-point FUNCTION NAME, not a line; 'Path not found: 1317'
- tldr explain FILE FUNCTION — returns METADATA (line range, complexity, callers, callees), never the body
- tldr search — returns a preview of whatever BM25 ranks first, not the symbol you asked for; it surfaced an unrelated function three times running
- fastedit read — symbols and line ranges, not content

So a test's assertion is effectively unreadable through the approved toolchain. The workaround used elsewhere this session (copy the file to a .txt and read that) is explicitly called out in the tldr/fastedit rule as necessary for a DIFFERENT reason (reconstructing a body for --replace), which suggests the gap is known and unaddressed rather than novel.

## Why it matters beyond convenience

The project's own review discipline requires distinguishing a test that guards from one that is vacuous — a test can call the real scanner and still assert on a field the mutation does not touch. That check is currently impossible without leaving the sanctioned tools. The consequence is that worker testimony about mutation checks cannot be independently verified, which is precisely the dependency the decide-on-facts rule forbids.

## Candidate fixes
- A tldr verb that emits a literal line range (tldr lines FILE START END), which is what chop and slice are repeatedly mistaken for.
- Teach tldr slice to accept the synthetic call-block names it emits from structure, so a test block is addressable by the name the tool itself printed.
- Or sanction an explicit escape: a documented copy-to-.txt-then-read recipe, so the workaround is a rule rather than a rediscovery.

## Acceptance
- [ ] One sanctioned command reads lines N..M of a source file and prints them verbatim.
- [ ] It works on a test block named by tldr structure.
- [ ] TRDD-4J1QA18G's open verification item becomes performable.

## Approval log

- 2026-09-13T22:11:33+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
