---
name: agentlens-diagnostics
description: >-
  Query AgentLens token/cost forensics from the shell — use when a session is burning tokens,
  a rate-limit window drains too fast, the prompt cache keeps breaking, you need the cost of a
  session / heartbeat / sub-agent fleet, or any "why is this so expensive" question. Covers all
  32 diagnostic tools (burn status, session burn profile, cache-break causes/timeline, expensive
  writes, heartbeat cost, config comparison, SQL analytics) via a CLI — the MCP server is
  deliberately NOT registered, so this skill is the only path to the tools.
---

# AgentLens diagnostics via CLI

All AgentLens diagnostic tools are called through **`node scripts/agentlens-cli.js`** (repo
root). The MCP server is deliberately **not registered** in `.mcp.json`: resident MCP schemas
cost ~8k tokens on every turn and any toolset change breaks the prompt-cache prefix. The CLI
costs zero resident tokens and its subcommands/flags/help are generated from the server's own
live schemas — never stale, no local registry.

## Prerequisite — the server must be running

The CLI talks to the standalone server at `http://localhost:4316/mcp` (`AGENTLENS_MCP_URL`
overrides). Ensure it idempotently:

```bash
pnpm run mcp:ensure     # starts it only if not already up
```

The CLI fails fast (non-zero exit, `FAIL: cannot reach …`) when the server is down — never
silently. If it fails, run `mcp:ensure` and retry once.

## Command surface

```bash
node scripts/agentlens-cli.js list --desc              # every tool + one-line description
node scripts/agentlens-cli.js help <tool>              # description + typed flags (live schema)
node scripts/agentlens-cli.js <tool> [--param value]   # direct call (kebab or camelCase flags)
node scripts/agentlens-cli.js call <tool> '<json>'     # raw JSON args
node scripts/agentlens-cli.js batch '<json-array>'     # N tools in ONE invocation
```

Globals on every form: `--out PATH` (full JSON to disk, one-line digest to stdout) and
`--full` (unshaped payload — responses are server-side lean by default). Object/array params
take a JSON string: `--filter '{"window":24}'`.

## Token-economy rules (the reason this CLI exists)

1. **Batch.** Need N answers? ONE `batch` invocation, not N calls — every separate tool call
   costs a full transcript re-read.
2. **`--out` + digest.** Route full payloads to a scratch file; only the one-line digest lands
   in context. Read back only the specific field you need (`jq`/Grep on the file).
3. **Discover, don't guess.** `list --desc` then `help <tool>` — unknown flags fail fast with
   the valid set.
4. Never paste a full JSON result into the conversation.

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| Is something burning RIGHT NOW? | `get_burn_status` |
| Why is THIS session expensive? | `get_session_burn_profile --sessionId <id>` |
| What keeps breaking the cache, machine-wide? | `get_cache_break_causes` |
| Per-turn break diagnosis of one session | `get_cache_break_timeline --sessionId <id>` |
| Biggest single cache writes + what's inside | `trace_expensive_writes` |
| What did the last janitor heartbeat cost? | `get_heartbeat_cost` |
| Which config (model/spawn/effort) costs most? | `compare_configs --groupBy <dim>` |
| Ad-hoc analytics over the fact DB | `run_diagnostics_sql --preset <name>` / `--sql '<SELECT…>'` |
| Recent sessions / workspace patterns | `get_recent_sessions`, `get_workspace_patterns` |

Sibling CLI for the janitor: `node scripts/agentlens-heartbeat-cost.js --oneline` prints the
exact settled cost of the previous heartbeat fire (see that script's header for why it reports
the previous fire — a hard constraint of the OTEL usage chain).
