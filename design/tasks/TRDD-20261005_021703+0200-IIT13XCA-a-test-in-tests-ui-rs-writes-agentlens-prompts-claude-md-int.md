---
trdd-id: IIT13XCA
title: A test in tests/ui.rs writes agentlens-prompts-claude.md into the crate directory
column: todo
status: tasked
created: 2026-10-05T02:17:03+0200
updated: 2026-10-05T02:28:02+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T02:17:03+0200
---

# A test in tests/ui.rs writes agentlens-prompts-claude.md into the crate directory

Found 2026-10-05 after a full run of cargo test -p agentlens-core: an untracked file rust-core/crates/agentlens-core/agentlens-prompts-claude.md (137 bytes, test data such as "test label" and "the prompt body") appeared, written relative to the test process's working directory. tests/ui.rs is the only Rust file naming it. The file is not gitignored, so staging that directory would commit it. Its headings read 2026-10-05 00:12:17 while the file was written at 02:12 local time, so the code under test formats UTC under a heading that reads as local: decide whether that is intended. Done when the test writes under a temp directory, a full crate test run leaves git status unchanged, and the timestamp question is answered on this card. The stray file was left in place.

## Approval log

- 2026-10-05T02:17:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Correction 2026-10-05

- CORRECTION to the title and body: the writer is production code, not the test. ui.rs appends the prompt to agentlens-prompts-<slug>.md under std::env::current_dir() by design (the comment there calls it Row 17, ported from server.ts). The test in tests/ui.rs exercises that route with the crate directory as its working directory, and its cleanup (a rename into the temp dir) leaves a file behind. So the fix is in the test's working directory or cleanup, and the UTC-looking heading is production behaviour: decide that separately.
