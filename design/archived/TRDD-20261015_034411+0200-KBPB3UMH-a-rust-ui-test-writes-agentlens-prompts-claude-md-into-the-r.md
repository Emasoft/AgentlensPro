---
trdd-id: KBPB3UMH
title: A Rust UI test writes agentlens-prompts-claude.md into the repo tree and never removes it
column: complete
status: archived
created: 2026-10-15T03:44:11+0200
updated: 2026-10-15T04:33:25+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T03:44:11+0200
project-id: agentlenspro
implementation-commits: [04691bec]
---

# A Rust UI test writes agentlens-prompts-claude.md into the repo tree and never removes it

## Problem
`tests/ui.rs::write_prompts_file_and_branch_dump` (rust-core/crates/agentlens-core/tests/ui.rs:635-654) makes the in-process server write `agentlens-prompts-claude.md` into the test process's real cwd (the crate dir), then tries to tidy it with `let _ = std::fs::rename(&file, std::env::temp_dir().join(...))`. On this machine the repo lives on /Volumes/EmaUITEK4TBSSD and temp_dir() is on the boot volume, so the rename is cross-device and fails (EXDEV, inferred from the volumes); `let _ =` swallows the error.

## Evidence (main agent, 2026-10-15)
- The untracked rust-core/crates/agentlens-core/agentlens-prompts-claude.md holds 10 pairs of the test's entries (32-byte header plus 10 x 105 bytes = its 1,082-byte size) ("test label" / "second"), with entry stamps 2026-10-05 00:12 through 2026-10-15 00:47 (apparently UTC: the file's mtime is 02:47 CEST), one pair per test run: the file is never removed and grows with every run.
- Consequence for the test itself: its first assertion claims "first entry creates the header", but from the second run on the file already exists, so the header-creation path is no longer exercised; "header once" still passes because the header was written on the first run only.

## Fix direction
Never write into the repo tree: give the write-prompts-file check its own scratch working directory (if the endpoint resolves the path from the process cwd, add a server-side override the test can set, or run that check in a subprocess with its own cwd), assert the file does not exist before the first post, and remove it with `std::fs::remove_file` checked (NotFound tolerated, any other error fails the test). Then delete the accumulated file (move it to .trashcan).

## Acceptance
- [x] A run leaves no file in the repo tree (it writes there only for the duration of the test; see residuals); `git status --short rust-core/` is unchanged across a run.
- [x] The header-creation assertion runs against a fresh file on every run: leftovers are removed before the first post and an exact one-entry count follows it.
- [x] The accumulated agentlens-prompts-claude.md is gone from the crate dir.

## Approval log

- 2026-10-15T03:44:11+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T04:33:25+0200 — COMPLETE by main-agent@agentlenspro. fixed in 04691bec; verified by repeated runs and a guard mutation.

## Notes and lessons learned

2026-10-15 residuals: (1) two cargo test processes in the same tree can delete each other's prompts file mid-test (the agent rule against two suite runs in one tree covers it; a configurable output dir for the endpoint would remove it); (2) the precondition removes a file with a fixed name in the crate dir, which would also remove a real prompts journal if someone ran a server from that dir.
2026-10-15: fixed in 04691bec; the test passes on repeated runs and leaves no file, disabling the guard's removal fails the absence assertion, clippy clean; running it deleted the accumulated untracked file.
