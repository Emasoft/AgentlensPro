---
trdd-id: ZR3OGSAV
title: save_pass_state silently ignores write and rename failures
column: todo
status: tasked
created: 2026-10-22T21:31:33+0200
updated: 2026-10-22T21:35:13+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T21:31:33+0200
---

# save_pass_state silently ignores write and rename failures

pass.rs save_pass_state (rust-core/crates/agentlens-store/src/pass.rs:101-111) discards both the fs::write error and the fs::rename result. A full disk or a permission error leaves the previous .pass-state.json in place with no log line. Skip names are pruned against the directory listing at every pass start (TRDD-2HRA270Y step 1), so a lost prune heals on the next good save; what is lost for real is a stranded name or a skip name added at ingest. A lost skip name means one extra re-read, which dedup makes a no-op. A lost stranded name means a parked file is gated again. The triggers (full disk, permissions) are hypothetical: no incident has been observed. Fix: return a Result, and surface it at every caller (four production callers as of 2026-10-22: chores.rs bodies_pass, server_stats.rs, alstore.rs pass, pass.rs unpark_names; plus one unit test in pass.rs; re-list with tldr references save_pass_state, as line numbers drift), logged every time or rate-limited, never swallowed. State whether a failed save should stop that pass's deletions. Keep the temp-and-rename atomicity. A stale .json.tmp left after a failed rename must also be removed or reported. Found while reviewing TRDD-2HRA270Y step 3 (docs_dev/20261022-step3-predesign.md). Tests inject each failure separately, without relying on a read-only directory, which is unreliable on macOS and under root. For the write branch, use a state path whose parent is a regular file (ENOTDIR). For the rename branch, make the target an existing non-empty directory, so the write succeeds and the rename fails.

## Approval log

- 2026-10-22T21:31:33+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
