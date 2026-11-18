---
trdd-id: ZKNP5IJY
title: Status-line reader and the TypeScript sealer still infer the JSON schema from the first rows of a file
column: todo
status: tasked
created: 2026-11-18T03:59:51+0100
updated: 2026-11-18T11:07:05+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T03:59:51+0100
parent-trdd: VS1FCUMU
---

# Status-line reader and the TypeScript sealer still infer the JSON schema from the first rows of a file

Split out of the sealer fix of TRDD-VS1FCUMU on 2026-11-18 (harness review: the reader change was outside that fix and unmeasured).

## What is known

- read_json_auto infers a schema from the first rows of a file unless sample_size=-1 is passed. Measured with the worktree alcore: on a 30,000-line file a key first seen in the last line was not a column of the sealed part and a later 1.5 in an integer column was stored as 2; on a live 291,970-line file keys first seen at lines 30,078 and 115,204 were not columns (reports_dev/VS1FCUMU/seal-proof/proof2-20261118_033742+0100/ and synth-prefix-20261118_035403+0100/).
- The sealer of the Rust core is fixed in TRDD-VS1FCUMU. Three call sites keep the default sample: the Rust reader (rust-core/crates/agentlens-core/src/statusline_store.rs, the read_json_auto call of the relation over write-ahead files, line 297 before the fix), the TypeScript reader (src/statuslineStore.ts 285) and the TypeScript sealOne (src/statuslineStore.ts 514 and 529).
- Effect of the two readers: a view over an UNSEALED write-ahead file longer than the sample does not see a key first seen later, and may read a rounded number. Nothing is lost on disk: the file is intact and its part is complete once sealed.
- The TypeScript sealOne is not known to be on a shipped path: grep for 'new StatuslineStore(' outside src/test in src and standalone returns 0 lines. This is one pattern only: tldr references for StatuslineStore, sealOne and maybeSeal is owed before the claim is relied on.

## Owed before any change

- [ ] Time statusline-history on a copy of a large write-ahead file with and without sample_size=-1, under scripts/test-data-cap.sh, with the memory limit and thread count the CLI really uses. One attempt with the node package at 512 MiB and default threads ran out of memory with and without the option, so it measured nothing.
- [ ] Decide: pass sample_size=-1 in the two readers, or leave them and say in the docs that an unsealed file is read through a sample.
- [ ] If the TypeScript sealOne is changed, a test of 30,000 lines with a late key must fail before and pass after.

## Approval log

- 2026-11-18T03:59:51+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## TypeScript half done 2026-11-18

Commit 3bc89368: sample_size=-1 at the three TypeScript read sites of src/statuslineStore.ts (relationFor, and the DESCRIBE and COPY of the seal path). Worker measurement on a 200,001-line, 96,977,867-byte file: default sample gave no late_key column, sample_size=-1 gave it; CPU about 304 and 253 ms before, about 821 and 793 ms after (wall time not usable, host under load). Test src/test/statuslineLateKey.test.ts: 2 failing before (Binder Error on late_key), 2 passing after, both by worker runs. The claim that a late fraction was rounded was never shown and was removed from the comment. STILL OPEN: the Rust reader rust-core/crates/agentlens-core/src/statusline_store.rs (about line 299) uses the default sample; it needs the same setting and a Rust test, built under the load gate.
