# agentlenspro-diagnostics — Options, hook events, bodies lifecycle

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Options (concise)

| Option | Effect |
|---|---|
| `--out PATH` | write the full JSON result to PATH; print only a one-line digest to stdout |
| `--full` | bypass the server's lean shaping (complete payload — pair it with `--out`) |
| `--status` | server health: pid, uptime, ports, memory, span store, EXACT disk bytes written since boot, bodies archive — or "not running" |
| `--start-server` | start the standalone server if not running (alone, or before any tool call); boot output goes to `~/.agentlens/server.log` |
| `--stop-server` | graceful SIGTERM (the server flushes every store first) |
| `--dashboard` | ensure the server is up, then open the dashboard (http://localhost:3000) |
| `--purge-db` | clear the span store + session cards; the server re-ingests from the agent logs |
| `--export-bodies DIR` | re-inflate archived OTEL bodies into DIR as plain files; `--since <hours\|ISO>` / `--until <ISO>` filter by time |
| `--purge-bodies` | delete archived body volumes proven durable in the store (each verified lump-by-lump); unproven volumes are kept and named, `.idx` sidecars always retained (the live 72h window is untouched) |
| `--risk` | one-shot realtime culprit check (~40ms REST fast path): prints only the ACTIVE burn risks, each naming the culprit session/workspace/model + magnitude |
| `--install-skill` | (re)install EVERY shipped skill into `~/.claude/skills/` (this one + `agentlenspro-cache-guard`) — idempotent, reports installed/updated/current per skill |
| `--install-hooks` | register the `agentlenspro hook` command string on the 10 LIFECYCLE hook events (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission, Notification, SubagentStart/Stop) AND the burn-gate (`agentlenspro gate` on PreToolUse/PostToolUse matched to `^(Task\|Agent\|Workflow\|SendMessage\|Read)$` — `Read` only for the image cache-guard, see "The burn-gate" below) via the same verified transaction. Bare bin + subcommand, never absolute paths — registrations survive Homebrew version bumps; the install refuses if `agentlenspro` is not on PATH. Each command carries `--stamp <version>` (the version of the CLI that registered it): setup and the launch repair leave a newer stamp in place, this verb overwrites it. Also migrates every previous-generation registration (`agentlenspro-hook`/`agentlenspro-gate` PATH bins, absolute-path `spy-agentlens*` scripts) and removes dead claude-spyglass entries. Never touches other tools' hooks. Idempotent; needs a session restart |
| `--uninstall-hooks` | remove exactly those agentlens hook entries — every generation: v2 command strings, v1 PATH-bin names, legacy absolute-path `spy-agentlens*` registrations (nothing else) |
| `--install-otel` | add the 19 Claude Code telemetry env vars to `~/.claude/settings.json` via a verified transaction: atomic backup+rename, cross-process lock, post-verify, refuses an unparseable file, all other content untouched, idempotent (`changed=false` when already installed) |
| `--uninstall-otel` | remove exactly those 19 vars, same guarantees |

Hook events: `--install-hooks` feeds lifecycle signals the transcripts/OTEL lack — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle — into `~/.agentlens/hook-events/` (NDJSON daily buckets, 31d retention).
Query: `GET /api/hook-events?session=&ev=&since=&until=&limit=` on the UI port.

Bodies lifecycle: raw capture is mandatory (every install converges `OTEL_LOG_RAW_API_BODIES`);
bodies land directly on the SSD at
`~/.agentlens/otel-bodies` (the RAM-disk spool was removed, TRDD-Z53IJFE9) and are drained every
60 s. Live plain files are ingested into a content-addressed store
(`~/.agentlens/store/` — fileless DuckDB → immutable zstd Parquet, deduped across turns,
~190× measured on this project's own history) — a source is deleted only after the store is proven
to hold its exact bytes AND its `(src_name, capture-time)` row, one gate shared by `.wad` volumes
and the hook-event spool; a payload that cannot ingest is quarantined, never deleted. The legacy monthly `.wad` archive
(`~/.agentlens/otel-bodies-archive/bodies-YYYY-MM.wad`) is a read-only fallback for history not
yet migrated, never written to again; `--export-bodies` reads from both. One server at a time:
the canonical instance owns `~/.agentlens/server.pid` and a second boot refuses cleanly.
`batch --out` files are position-prefixed (`out-1-<tool>.json`).

## Output formats

- **Default (no `--out`)**: pretty-printed JSON of the server's lean-shaped result — verdict and
  scalars first, arrays capped at the top rows, truncation always disclosed in `_truncated`.
- **`--out PATH`**: one-line digest (the `verdict` field when present) to stdout + complete JSON
  on disk. This is the token-economical default for agents.
- **`--full`**: unshaped payload (every row, derivations, remediation strings).
- `run_diagnostics_sql` additionally takes `--format table|markdown|json` for rendered output.
- Errors: `FAIL: <reason>` on stderr, non-zero exit (server unreachable, unknown tool/flag) —
  never a silent fallback.

