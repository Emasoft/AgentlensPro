---
trdd-id: VS1FCUMU
title: The status line is stored with no server - hook appends to the write-ahead file and alcore statusline-seal compacts
column: dev
status: tasked
created: 2026-11-18T02:15:01+0100
updated: 2026-11-18T02:15:01+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T02:15:01+0100
---

# The status line is stored with no server - hook appends to the write-ahead file and alcore statusline-seal compacts

## Why

Owner, 2026-11-18 (verbatim), answering "accept the loss of status-line samples when no server answers?":

> no, status line hook must be digested at all times. disable must never disable the status line hook. just calling some fast binary to add the data to the duckdb. no need for the full server to be online.

On branch `feat/rbbex59r-c2` (TRDD-RBBEX59R step d3) the status-line hook only POSTs to the server; a sample taken while no server answers is lost. That branch must not land until this card is done. This card is a prerequisite (NPT) of TRDD-RBBEX59R.

## Design (decided by the main agent, reviewed with the advisor, 2026-11-18)

1. The hook POSTs first, as today. When the server did not take the sample (connection refused, error, non-2xx) the hook appends the flattened sample to the store's own write-ahead file `<dataDir>/statusline/<stream>/<UTC day>/wal-cli.ndjson` with one `appendFileSync` (O_APPEND, no child process). Both readers (Rust `relation_for`, TypeScript `relationFor`) already union every `wal-*.ndjson`, so the sample is queryable at once.
2. When the POST is still pending at the render deadline (the server accepted and does not answer), the hook appends the sample locally and returns. The server may store the same sample later, so a duplicate row is possible. Accepted: the stream is already re-sampled many times per turn and the views read per-turn buckets and cumulative deltas.
3. The hook appends; the binary only compacts. New command `alcore statusline-seal --data-dir DIR` runs the existing `maybe_seal` with no server: no port, no pidfile, `nice(15)`. It does NOT run `purge`: retention stays with the server, so a standalone run can never delete a day.
4. Safety lives inside `maybe_seal`, so the server chore and the standalone command are both covered:
   - a cross-process lock `<statusline root>/.seal.lock` (flock, non-blocking): a second sealer returns 0;
   - `wal-<pid>.ndjson` whose pid is the live pidfile owner of the data dir is never touched by another process;
   - `wal-cli.ndjson` is a LIVE file: it is renamed first (`wal-cli.rot-<pid>-<base36><seq>.ndjson`), the sealer waits 150 ms so an appender that opened the old name finishes its one write, then it seals the renamed file;
   - today's `wal-cli.ndjson` is sealed only at `AGENTLENS_STATUSLINE_CLI_SEAL_BYTES` (default 16 MiB), a past day's always;
   - one call starts no new seal after `AGENTLENS_STATUSLINE_SEAL_BUDGET_MS` (default 20,000 ms), so a backlog drains over several calls;
   - `count_lines` streams the file instead of loading it whole (a CLI write-ahead file can be hundreds of MB).
5. The hook starts the sealer detached, only when (a) its append created today's file (the day turned) or the file reached the same byte threshold, (b) no start happened in the last 30 s (stamp `<statusline root>/.seal-kick`), (c) no live server owns the data dir (its 60 s chore seals), (d) `AGENTLENS_NO_REVIVE` is not `1` (the one brake for every detached process a hook starts).
6. The revive after a failed status-line POST is unchanged (it serves the spawn guards).

## Known limits

- A pid reused by an unrelated live process is read as a live owner only when the pidfile names it; a stale pidfile is not verified against the process start time here.
- A duplicate row is possible in case 2.
- With no server for longer than the retention window, old days are not purged until a server runs.
- The sealer is started by the hook only; nothing seals when no status line renders.

## Files (worktree `builds_dev/rbbex59r-c2`, branch `feat/rbbex59r-c2`)

- Rust: `rust-core/crates/agentlens-core/src/statusline_store.rs`, `src/pid_lock.rs`, `src/bin/alcore.rs`, new test `tests/statusline_seal_cli.rs`.
- TypeScript: `src/cli/hookHandlers.ts` (`forwardHookEvent` resolves a boolean), `src/cli/statuslineCapture.ts`, `src/test/statuslineCapture.test.ts`, new test `src/test/statuslineDiskFallback.test.ts`.
- Afterwards: joint leg 10 in `src/test/noCollectionJoint.test.ts`, `docs/operations.md`, `CHANGELOG.md`.

## Checklist

- [ ] Rust change + `tests/statusline_seal_cli.rs` green, `statusline_parity` and the `statusline_store` unit tests green, clippy clean
- [ ] TypeScript change + `statuslineDiskFallback.test.ts` and `statuslineCapture.test.ts` green, check-types clean
- [ ] Joint leg 10: no server, sample on disk, `statusline-history` shows it, `alcore statusline-seal` makes a part
- [ ] Docs: operations.md, CHANGELOG, the header comments of the two source files
- [ ] Sealer proved on a sample of at most 4 GB of the live backlog before the live deploy

## Approval log

- 2026-11-18T02:15:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
