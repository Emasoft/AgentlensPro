---
trdd-id: TQKK17XZ
title: The session-id branch of the causing-call transcript lookup lists project dirs in filesystem order
column: todo
status: tasked
created: 2026-11-19T23:11:43+0100
updated: 2026-11-19T23:39:02+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:11:43+0100
---

# The session-id branch of the causing-call transcript lookup lists project dirs in filesystem order

rust-core/crates/agentlens-core/src/burn/causing_tool_call.rs:118-126 (read_dir over each projects dir) and src/causingToolCall.ts:96-103 (fs.readdirSync) return the session's transcript paths in raw filesystem order, unsorted. d294ad91 sorted the raw-body listing for the same reason (order differs between APFS and Linux ext4). Effect only when one session id has a transcript under two project dirs; then the two runtimes may disagree in order. Fix: sort the sub-dir names in both, add a parity fixture with two dirs. Found 2026-11-19T23:11+0100 while closing TRDD-HSPUF5XH.

## Approval log

- 2026-11-19T23:11:43+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-19T23:16+0100: fix edited in worktree /private/tmp/wt-causing-sort (2 files, +9 -2, not compiled). Rust sorts by UTF-8 bytes, JS by UTF-16 units, and Rust drops non-UTF-8 names: identical only for ASCII names, which Claude project-dir slugs are. Still open: a unit test with two project dirs holding the same session id, and cargo check after the release gate.
2026-11-19T23:21+0100: the worker found the workspace branch also lists dirs unsorted (causing_tool_call.rs:143, causingToolCall.ts:120) before an mtime sort (rs:158 cand.sort_by, ts:133 cand.sort); equal mtimes keep filesystem order. Same fix there: sort the names before the mtime sort. Worker report: reports_dev/TQKK17XZ/20261119-sort-fix.md.
2026-11-19T23:25+0100: worktree diff now 2 files for this card (causing_tool_call.rs +8 -1, causingToolCall.ts +5 -1, comments wrapped). FINDING: sorting the file list alone does not fix TS output order: the TS query ends ORDER BY timestamp ASC (src/causingToolCall.ts:187) with no tie key and DuckDB's sort is not stable, while Rust sorts in Rust with a stable sort (causing_tool_call.rs:233). Fix: ORDER BY timestamp ASC, filename ASC in the TS query; then a two-dir equal-timestamp test is deterministic.
2026-11-19T23:29+0100: Rust row order read: rows.sort_by on timestamp only (causing_tool_call.rs:234), a stable sort over files in cand order (session branch: sorted names; workspace branch: mtime-desc at :158). Decided tie key for BOTH runtimes: (timestamp, file path); Rust keeps line order inside a file by stability. Open: TS ties inside one file (several tool_use blocks in one assistant message share a timestamp) follow DuckDB's sort, whose stability is INFERRED not verified; measure with a repeated run.
2026-11-19T23:32+0100: the tie test (worker a43ee) is NOT proven red-before: resolveTranscripts already sorts, so DuckDB may return a-first without the filename ASC key. After the release gate run it once with and once without ', filename ASC'; it is a guard only if the run without the key fails.
2026-11-19T23:39+0100: worktree now has the Rust tie key too (causing_tool_call.rs:192 file_key, :230 push, :236 sort_by ts then path) and the TS key (src/causingToolCall.ts:188). NOT compiled. After the gate: (a) cargo check -p agentlens-core; (b) run the TS tie test without ', filename ASC' (must fail) and with it; if it passes without, use the worker's fixture (b-proj under root/z-first, a-proj under root/a-second, projectsDirs [z-first, a-second]) so file order and path order disagree; (c) check DuckDB VARCHAR ordering is binary like Rust String; (d) run the causing-call parity test and regenerate its gen-*.mjs fixture if the order changed.
