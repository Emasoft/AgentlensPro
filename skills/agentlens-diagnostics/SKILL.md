---
name: agentlens-diagnostics
description: >-
  Query AgentLens token/cost forensics from any project via the global agentlens-cli — use when
  a session is burning tokens, a rate-limit window drains too fast, the prompt cache keeps
  breaking, you need the cost of a session / heartbeat / sub-agent fleet, or any "why is this so
  expensive" question. Covers all 32 diagnostic tools (burn status, session burn profile,
  cache-break causes/timeline, expensive writes, heartbeat cost, config comparison, SQL
  analytics). Also the operations surface: start the server (--start-server), open the
  dashboard (--dashboard), install AgentLens itself (scripts/install.sh, --install-skill),
  and wire/unwire Claude Code capture — telemetry env vars (--install-otel / --uninstall-otel)
  and lifecycle hook events (--install-hooks / --uninstall-hooks).
---

# AgentLens diagnostics via the global CLI

`agentlens-cli` is installed globally (`/opt/homebrew/bin/agentlens-cli`, linked from the
AgentLens repo) and works from **any** project directory. The AgentLens MCP server is
deliberately NOT registered anywhere: resident MCP schemas cost ~8k tokens on every turn and
toolset changes break the prompt-cache prefix. The CLI costs zero resident tokens; its
subcommands, flags, and help come from the server's own live schemas, so it is never stale.

If `agentlens-cli` is not on PATH, it was unlinked — run `npm link` inside the AgentLens repo
(or `bash scripts/install.sh`) to restore it. This skill never installs the server itself; the
CLI starts it on demand.

## Commands

```bash
agentlens-cli list --desc                    # every tool + one-line description
agentlens-cli help <tool>                    # a tool's description + typed flags (live schema)
agentlens-cli <tool> [--param value ...]     # direct call
agentlens-cli call <tool> '<json-args>'      # raw JSON args object
agentlens-cli batch '<json-array>'           # N tools in ONE invocation: [{"tool":"…","args":{…}}]
```

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
| `--purge-bodies` | delete ALL archived body volumes (the live 72h window is untouched) |
| `--install-skill` | (re)install THIS skill into `~/.claude/skills/` — idempotent, reports installed/updated/current |
| `--install-hooks` | register `spy-agentlens.sh` on the 10 LIFECYCLE hook events (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission, Notification, SubagentStart/Stop) via the same verified transaction; also removes dead claude-spyglass entries. Never touches other tools' hooks. Idempotent; needs a session restart |
| `--uninstall-hooks` | remove exactly those spy-agentlens hook entries (nothing else) |
| `--install-otel` | add the 19 Claude Code telemetry env vars to `~/.claude/settings.json` via a verified transaction: atomic backup+rename, cross-process lock, post-verify, refuses an unparseable file, all other content untouched, idempotent (`changed=false` when already installed) |
| `--uninstall-otel` | remove exactly those 19 vars, same guarantees |

Hook events: `--install-hooks` feeds lifecycle signals the transcripts/OTEL lack — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle — into `~/.agentlens/hook-events/` (NDJSON daily buckets, 31d retention).
Query: `GET /api/hook-events?session=&ev=&since=&until=&limit=` on the UI port.

Bodies lifecycle: live plain files for 72h → auto-archived hourly into monthly WAD volumes
(`~/.agentlens/otel-bodies-archive/bodies-YYYY-MM.wad` — gzip lumps + NDJSON index, random
access, ~8-10× smaller) → volumes deleted only after `AGENTLENS_BODIES_RETENTION_DAYS` (31).
One server at a time: the canonical instance owns `~/.agentlens/server.pid` and a second
boot refuses cleanly. `batch --out` files are position-prefixed (`out-1-<tool>.json`).

## Output formats

- **Default (no `--out`)**: pretty-printed JSON of the server's lean-shaped result — verdict and
  scalars first, arrays capped at the top rows, truncation always disclosed in `_truncated`.
- **`--out PATH`**: one-line digest (the `verdict` field when present) to stdout + complete JSON
  on disk. This is the token-economical default for agents.
- **`--full`**: unshaped payload (every row, derivations, remediation strings).
- `run_diagnostics_sql` additionally takes `--format table|markdown|json` for rendered output.
- Errors: `FAIL: <reason>` on stderr, non-zero exit (server unreachable, unknown tool/flag) —
  never a silent fallback.

## Rules for agents

1. **Batch** — N answers = ONE `batch` invocation, never N separate calls (each call costs a
   full transcript re-read).
2. **`--out` to the reports folder** — full payloads belong on disk, never in context. Save to
   the MAIN repo's `./reports/agentlens-diagnostics/` with a local-time+offset timestamp:

   ```bash
   MAIN_ROOT="$(git worktree list | head -n1 | awk '{print $1}')"
   REPORT_DIR="$MAIN_ROOT/reports/agentlens-diagnostics"; mkdir -p "$REPORT_DIR"
   agentlens-cli get_cache_break_causes --out "$REPORT_DIR/$(date +%Y%m%d_%H%M%S%z)-break-causes.json"
   ```

   (`./reports/` must be gitignored; add it if missing.) Read back only the fields you need.
3. **Discover, don't guess** — `list --desc` then `help <tool>`.
4. Never paste a full JSON result into the conversation.

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| Is something burning RIGHT NOW? | `get_burn_status` |
| Why is THIS session expensive? | `get_session_burn_profile --sessionId <id>` |
| What keeps breaking the cache, machine-wide? | `get_cache_break_causes` |
| Per-turn break diagnosis of one session | `get_cache_break_timeline --sessionId <id>` |
| TTL expiry vs real prefix change? | `get_cache_break_gap_report` |
| Biggest single cache writes + contents | `trace_expensive_writes` |
| What did the last janitor heartbeat cost? | `get_heartbeat_cost` |
| Which config (model/spawn/effort) costs most? | `compare_configs --groupBy <dim>` |
| Ad-hoc analytics over the fact DB | `run_diagnostics_sql --preset <name>` / `--sql '<SELECT…>'` |
| Recent sessions / workspace patterns | `get_recent_sessions`, `get_workspace_patterns` |

Sibling CLI for the janitor heartbeat: `agentlens-heartbeat-cost --oneline` (in the AgentLens
repo `scripts/`) prints the exact settled cost of the previous heartbeat fire.
