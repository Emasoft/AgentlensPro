---
trdd-id: HH1NP0KD
title: Replace the Node CLI on every hook and statusline path with small dedicated Rust binaries
column: design
status: tasked
created: 2026-10-03T20:40:31+0200
updated: 2026-10-03T21:06:43+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T20:40:31+0200
npt: []
---

# Replace the Node CLI on every hook and statusline path with small dedicated Rust binaries

## Why
Owner directive 2026-10-03: "why are you using the same cli executable for all hooks?  just create some small fast rust digest-optimized and focused binaries, simple thin wrappers over duckdb." and "the hooks should do the same, each with a super optimized custom rust ingester running superfast duckdb in few milliseconds." Estimated (only the per-spawn cost is measured): every hook/statusline fire spawns the full Node agentlenspro CLI, about 230 ms CPU and 71 MB RSS per spawn whatever the verb does; about 53k spawns per day (statusline about 60%), roughly 3.4 CPU-hours per day. Evidence: reports/hook-binaries/20261003_203907+0200-hook-inventory.md (gitignored, local).
The 230 ms CPU / 71 MB figure was measured on `--version` at load average 92-112. Spawn counts are partial-day: statusline is a lower bound (stored samples), gate an upper bound, review-gate and review-supervisor inferred from Stop/SubagentStop counts, UserPromptSubmit unknown.
## Scope
Five verbs: hook (15 events), gate (PreToolUse+PostToolUse), review-gate (Stop, SubagentStop), review-supervisor (Stop, UserPromptSubmit), statusline. Each moves off the Node CLI (to a focused Rust binary, one multi-call binary, or a curl call in the existing wrapper: see Options to benchmark) and keeps the exact output contract listed in the inventory (kill-switch first, stdout contract, exit 0, timeouts, spool/revive for hook, fail-open for gate, inner-command passthrough for statusline).
## Open decision (pending measurement)
DuckDB allows concurrent writes inside one process; across processes it needs a server: the Quack client-server extension (DuckDB >= 1.5.3, documented experimental) or DuckLake with a PostgreSQL catalog. Candidates being benchmarked: shared file, per-session file, spool file read later by DuckDB, plain POST to alcore, Quack client attached to alcore. Pick per hook kind by CPU-ms per event, binary size, and zero lost events under 22 concurrent sessions.
## Constraints
review-supervisor matches the literal command string "agentlenspro review-gate" in settings files; renaming the hook command needs that check updated in the same change. Settings changes need owner approval.

## Approval log

- 2026-10-03T20:40:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Owner statements (verbatim, 2026-10-03)

- "the hooks should do the same, each with a super optimized custom rust ingester running superfast duckdb in few milliseconds."
- "why they should open the same file for writing? duckdb handle concurrency by itself. it never fails."
- "multiple sql transaction are designed to be never in conflict."
- "an sql server  is designed to accept transactions from multiple clients at the same time. you should read duckdb docs."
- "you can update the duckdb version to take advantage of the new features and bugfixes" (the DuckDB crate bump, tracked under TRDD-9VX3WTGU)

## Verified DuckDB constraints

- DuckDB docs (duckdb.org/docs/current/connect/concurrency.html): "one process can both read and write to the database"; "multiple processes can read from the database, but no processes can write"; concurrency control is "all within that single writer process".
- Multi-process writes are supported through the Quack protocol (core extension, DuckDB >= 1.5.3, documented "still subject to change") or DuckLake with a PostgreSQL catalog.
- Consequence: a hook process cannot write the live alcore file (documented). That it cannot read it either while alcore holds it read-write is inferred from the read-only mode description and not yet measured. So a hook goes through alcore (Quack or HTTP) or uses its own file/spool.
- Within alcore, plain appends never conflict; `INSERT ... ON CONFLICT` on a key and the `node_rollup` UPDATE can conflict if issued from two connections (inferred, not measured; the writer design belongs to TRDD-9VX3WTGU), so they stay on one writer connection.

## Options to benchmark

- (a) curl -m in the existing bash wrapper with spool fallback (no new binary).
- (b) One multi-call Rust binary (argv[0]/subcommand) instead of five.
- (c) Per-verb binaries.
- (d) DuckDB-linked client via Quack vs std-only HTTP client.
- Size (worst case, inferred from alstore at 39.9 MB / 11.8 MB gzipped; a minimal DuckDB-only client is unmeasured; only strip -S was measured, saving 0 bytes): five separate DuckDB-linked binaries x 4 platforms would add about 240 MB gzipped. A hook client built into an already DuckDB-linked binary adds close to nothing. Pending: whether Quack can be statically linked in the bundled build or must be downloaded at runtime (a runtime download is unacceptable on a hook path).

## Scope notes

- Statusline gain is capped at the Node share: the bash wrapper, the detached AI Maestro ingest and python statusline.py remain.
- Revive guard order, dataDir/uiBaseUrl/ports.json/kill-switch must have a shared parity test with the TS.
- review-supervisor uses process.cwd(), not the payload cwd.
- Stage review-gate last (about 1300 lines TS, pinned tests as oracle).
- Packaging: bin-native entries, macOS ad-hoc codesign, chmod +x after artifact download, check-dist-contents and verify-bin-native allowlists, publish.yml matrix, --install-hooks/setup migration via safeConfigEdit.
- Keep timeouts: statusline 700 ms (+50 ms residual), hook 2 s, gate 4 s.
- Acceptance under at least 3x today's 22 concurrent sessions (22 is one moment's process count, 3x a chosen margin).

## Related

TRDD-9VX3WTGU (DuckDB redesign): coordinate the gate contract with its post-cutover API. Not a prerequisite: review-gate and review-supervisor never call alcore, and the redesign does not change /api/hook-events or /api/statusline-samples. After the benchmark, split this card into derived cards: statusline+hook transport, gate, review-gate+review-supervisor port (last), plus EHTs for setup/--install-hooks migration with the review-supervisor string-match fix, and for packaging/codesign.
