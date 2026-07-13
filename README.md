<h1><img src="media/mascot.png" alt="" width="48" align="center" /> AgentlensPro</h1>

[![CI](https://github.com/Emasoft/AgentlensPro/actions/workflows/ci.yml/badge.svg)](https://github.com/Emasoft/AgentlensPro/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Emasoft/AgentlensPro)](LICENSE)

![AgentlensPro demo](media/demo.gif)

**Professional local observability for AI agent sessions** — a CLI, a server-hosted dashboard, and Claude Code skills that show you what's happening inside each run. No data leaves your machine.

AgentlensPro is the professional version of AgentLens, birthed from a fork of [AgentLens](https://github.com/RogerReed/agentlens).

AgentlensPro receives **OpenTelemetry traces** from Copilot, Claude Code, and Codex in real time — giving you span timing, time-to-first-token, loop detection, file diffs, and actionable recommendations. It also reads **local session files** written automatically by each agent as a zero-config fallback — including OpenCode's local **SQLite database** — backfilling history and filling gaps when OTEL isn't configured. Both sources are shown in one unified dashboard, and 32 diagnostic tools are exposed through the single `agentlenspro` command and the bundled Claude Code skill.

## Compatibility

AgentlensPro keeps the following surfaces byte-compatible with AgentLens so existing installs keep working unchanged (renaming them is deferred to a later major version):

- **`~/.agentlens`** — the data directory (spans, session cards, offsets) is unchanged.
- **`AGENTLENS_*` environment variables** — all server/gate/retention tuning vars keep their names.
- **Hook registrations self-migrate** — since v2.0.0 hooks are registered as the command strings `agentlenspro hook` / `agentlenspro gate` (see [the single-executable contract](#the-single-executable-contract)). `agentlenspro setup` (or a re-run of `--install-hooks`) rewrites every previous generation found in `~/.claude/settings.json`: the v1 `agentlenspro-hook`/`agentlenspro-gate` PATH bins and the v0 absolute-path `spy-agentlens*` entries.

## Getting Started

### Local (OTEL and log files)

The fastest way to get started — run directly on your machine with no install required. Because it runs natively it has full access to your local session log files.

```bash
# One-off — always uses the latest published version
npx agentlenspro
bunx agentlenspro

# Or install globally and run by command name
npm install -g agentlenspro
agentlenspro
```

Open <http://localhost:3000> after the server starts. The OTLP receiver listens on port `4318`. Configure agents to point at `http://localhost:4318` (see [Manual Configuration](#manual-configuration)).

> **Log file ingestion** reads local session files from `~/.claude/`, `~/.codex/`, `~/.copilot/`, and OpenCode's SQLite database at `~/.local/share/opencode/` directly. See [Local Mode Options](#local-mode-options) for environment variables.

### Setup, diagnostics CLI, and Claude Code skill

`agentlenspro setup` is the one-command installer/repairer: it detects the current state
(server, data store, hooks, skill, telemetry env — including broken or partial installs),
converges every piece, **independently verifies each step**, and finishes with an
end-to-end self-test. It is idempotent — a second run is all no-ops.

```bash
agentlenspro setup                        # detect → converge → verify → self-test
agentlenspro setup --dry-run              # print the per-step plan, change nothing
agentlenspro setup --yes                  # non-interactive (accepts e.g. old-package removal)
```

The same executable exposes every diagnostic tool (recent sessions, cost, burn budget,
cache-expiry, workspace patterns, …) against the running server — run `agentlenspro list`
to see the full set — plus the individual installers:

```bash
agentlenspro server start                 # server up (idempotent); `dashboard` opens the UI
agentlenspro server status                # pid, uptime, memory, span store, disk writes
agentlenspro list --desc                  # discover tools
agentlenspro help <tool>                  # flags from the live schema
agentlenspro <tool> --param value --out FILE   # full JSON to disk, digest to stdout
agentlenspro --install-otel               # wire Claude Code telemetry (verified transaction)
agentlenspro --install-hooks              # wire lifecycle hook capture + the burn-gate
agentlenspro --install-skill              # (re)install the agentlenspro-diagnostics skill
```

#### The single-executable contract

The package publishes exactly ONE bin (`package.json → bin`): `agentlenspro`. Everything —
server control, dashboard, diagnostics, the hook entry points, heartbeat cost, setup — is a
subcommand. Hooks are registered in `~/.claude/settings.json` as the command strings
`agentlenspro hook` / `agentlenspro gate` (hook commands are shell strings, so arguments
are valid) — never absolute paths into the package tree, so registrations survive package
relocations (an absolute path under Homebrew's versioned Cellar would dangle after every
`brew upgrade`). The installer refuses to register the commands when `agentlenspro` does
not resolve on `PATH` (a hook the shell cannot find would silently never fire).
`--uninstall-hooks` removes every generation: the v2 command strings, the v1
`agentlenspro-hook`/`agentlenspro-gate` PATH-bin names, and any v0 absolute-path
`spy-agentlens*` entries.

### Docker (OTEL only)

> **Note:** Docker cannot read local session log files from your host machine without explicit volume mounts for each agent directory. Docker mode receives OTEL traces only — log file ingestion is not available. Use the local option above if you need log file history.

The image is published to GitHub Container Registry (`ghcr.io/emasoft/agentlenspro`) by the tag-triggered [docker workflow](.github/workflows/docker.yml), with SLSA build provenance attached to the manifest.

```bash
# Ephemeral — data cleared on container stop (always pulls latest)
docker run --pull=always -p 127.0.0.1:3000:3000 -p 127.0.0.1:4318:4318 ghcr.io/emasoft/agentlenspro

# Persistent — data survives restarts (macOS/Linux)
docker run --pull=always -p 127.0.0.1:3000:3000 -p 127.0.0.1:4318:4318 \
  -v ~/.agentlens:/data \
  ghcr.io/emasoft/agentlenspro

# Persistent — data survives restarts (Windows)
docker run --pull=always -p 127.0.0.1:3000:3000 -p 127.0.0.1:4318:4318 `
  -v "$env:USERPROFILE\.agentlens:/data" `
  ghcr.io/emasoft/agentlenspro
```

Open <http://localhost:3000> after the container starts.

#### Configuring Agents for Local / Docker

Run `agentlenspro setup` to configure the Claude Code integration automatically (telemetry
env, hooks, skill — each step verified), or see [Manual Configuration](#manual-configuration)
for the manual steps for every agent (Claude Code, Codex, Copilot CLI).

## Features

- **OpenTelemetry collection** — Built-in OTEL receiver captures real-time traces and logs from Copilot, Claude Code, and Codex with no external infrastructure
- **Log file ingestion** — Reads local session files and databases written automatically by each agent as a zero-config fallback — including JSONL logs for Claude Code, Codex, and Copilot, and OpenCode's SQLite database — backfilling history when OTEL isn't configured (native process only)
- **Sessions Table** — Drill into any session: expand a row to see a full waterfall trace, turn-to-tool flow graph, tool distribution chart, and modified files — all without leaving the session list
- **Copy branch tree** — From an expanded session (or a sub-agent branch, or the Flow view), the **⧉ tree** button copies the whole branch — the session and its recursive sub-agents, every step's thinking/response/tool I/O — as a self-describing text tree with a session-id + project-slug header and a grep-able OTEL match key (`⟨span/req/trace⟩`) per node. Oversized outputs are written to dump files under the project's `~/.claude/projects/<slug>/agentlens-branch-dumps/` and referenced by path, keeping the clipboard small. Ideal for pasting a full run into another agent for analysis.
- **Analytics** — Aggregate charts across the active time range: per-agent breakdown, estimated cost with a daily total overlay, token usage per session, and context growth
- **Advisor** — Project-scoped suggestions for improving your agent instruction file (CLAUDE.md, AGENTS.md, or similar): detects hot files the agent rediscovers every session, loop patterns, high turn-count trends, and scope problems — each suggestion includes ready-to-copy instruction text and an inquiry prompt you can paste directly into your agent. Also includes an efficiency scatter plot (cost vs. LLM calls, colored by cache hit rate) and hot files ranked by access frequency. Select a specific project from the filter for tailored suggestions; all-projects view surfaces only universal patterns.
- **Cost Estimation** — Estimates session cost for Copilot (three billing models), Claude Code, and Codex, broken down by model in a day-grouped table
- **Efficiency & Inefficiency Detection** — Surfaces context bloat, redundant tool calls, cache misses, and five loop/malfunction patterns with suggested prompts to correct course
- **Configurable Alerts** — Threshold-based notifications for turns, errors, active time, and repeat tool calls — per-agent or shared
- **Export** — Export filtered sessions as JSON (full or redacted); respects the active agent, source, time range, and text filters
- **Import** — Import sessions from a previous AgentlensPro (or AgentLens) JSON export; drag-drop or file-pick, shows a preview with session count by source and date range, imports with live progress and automatic deduplication (existing sessions are skipped)

## Data Sources

AgentlensPro collects data from two independent sources per agent. Each session row shows a badge — **OTEL** or **Log** — indicating where its data came from. If both capture the same session: for Claude sessions the log transcript wins on collision (OTEL is a lossy lower bound), and OTEL wins only where no transcript exists; for every other agent OTEL wins.

### OpenTelemetry traces (primary source)

The server runs a built-in OTLP HTTP receiver on port `4318` in both native and Docker modes. OTEL data is the richest source: real-time span timing, time-to-first-token, per-tool latency, loop detection signals, file diff content, and streaming speed. Sessions from OTEL show an **OTEL** badge.

See [Manual Configuration](#manual-configuration) for the specific settings each agent needs. OTEL is the only data source available in Docker mode.

### Log file ingestion (fallback source, native process only)

AgentlensPro also reads the local session files that Claude Code, Codex, Copilot CLI, and Copilot Chat write automatically to your home directory. This requires no configuration and backfills session history that predates OTEL setup. Log-sourced sessions show a **Log** badge. **Not available in Docker mode** — the container cannot access host log directories without explicit volume mounts for every agent path.

| Agent | Log file location (Mac/Linux) | Windows |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` | `%APPDATA%\Claude\projects\...` |
| **Codex CLI** | `~/.codex/sessions/<project>/<session>.jsonl` | `%USERPROFILE%\.codex\sessions\...` |
| **Copilot CLI** | `~/.copilot/session-state/<session>/events.jsonl` | `%USERPROFILE%\.copilot\session-state\...` |
| **Copilot Chat** | `~/Library/Application Support/<IDE>/User/workspaceStorage/…/chatSessions/` | `%APPDATA%\<IDE>\User\workspaceStorage\…\chatSessions\` |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite) | `%APPDATA%\opencode\opencode.db` |

Copilot Chat sessions are scanned across all installed VS Code-family IDEs automatically — VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium, Trae, and Kiro.

Loading is incremental and runs in the background, sorted newest-first so recent sessions appear immediately. A 30-second poll picks up new sessions as they complete.

**What log data includes:** session ID, workspace, model, timestamps, token counts (input, output, cache read/write), tool calls and file operations (Claude Code and OpenCode), user prompt (Claude Code, Copilot CLI, and OpenCode).

**What log data does not include:** time-to-first-token, per-tool execution timing, streaming speed, loop detection signals, or structured error telemetry. Enable OTEL for those. OpenCode sessions show a blue info banner in the Session Overview noting that OTEL traces and TTFT are not available.

## Data retention

All ingested data lives under the data directory (`~/.agentlens`, or `$DATA_DIR`). This directory is **independent of where the package is installed** — it survives an uninstall, a version upgrade, and a CLI-path change, so your history is never lost when you update. Deletion is always logged, never silent, and only ever removes whole expired segments/volumes (spans and OTEL bodies are archived, never truncated mid-window).

Five knobs control how long each kind of data is kept:

| Knob | Default | Environment variable | What it governs |
| --- | --- | --- | --- |
| `spansRetentionDays` | 30 days | `AGENTLENS_SPANS_RETENTION_DAYS` | span segments (the trace DB) kept on disk |
| `summaryWindowHours` | 24 hours | `AGENTLENS_SUMMARY_WINDOW_HOURS` | in-memory rolling summary window (disk keeps everything) |
| `bodiesMaxAgeHours` | 72 hours | `AGENTLENS_BODIES_MAX_AGE_HOURS` | raw OTEL bodies kept as plain files before archiving |
| `bodiesMaxGb` | 8 GB | `AGENTLENS_BODIES_MAX_GB` | live-bodies size cap (archives oldest-first; never deletes) |
| `bodiesRetentionDays` | 31 days | `AGENTLENS_BODIES_RETENTION_DAYS` | archived OTEL bodies kept before whole-volume deletion |

**Set a value persistently** with the CLI — it is written to `~/.agentlens/config.json` (in the durable data directory, so it too survives uninstall/upgrade, and the always-on daemon re-reads it every boot):

```bash
agentlenspro config                              # list every knob: effective value + source
agentlenspro config get spansRetentionDays       # one knob's value + where it came from
agentlenspro config set spansRetentionDays 90    # persist a change (restart the server/daemon to apply)
```

Each knob is resolved at boot with the precedence **environment variable > `config.json` > built-in default** — the env var stays the ephemeral ops override, the file is the durable setting you set once. Every value has a safety floor (e.g. days ≥ 1), and a below-floor value from any source is clamped. Restart the server/daemon (`agentlenspro server restart`) after a change.

## Environment diagnostics

`agentlenspro env` reports the full nature of the environment the CLI is running in — entirely client-side (no server needed). Query one facet, or omit the facet for the whole report; `--json` emits a machine-readable object and `--out FILE` writes the full JSON to disk while printing only a one-line digest (so a big report never floods your terminal or an agent's context).

```bash
agentlenspro env                       # whole environment, human digest
agentlenspro env list                  # the available facets
agentlenspro env terminal              # just the terminal/host facet
agentlenspro env --json --out env.json # full report to a file (digest to stdout)
```

Ten facets are detected:

| Facet | What it reports |
| --- | --- |
| `terminal` | hosting terminal by **process ancestry** (iTerm/Ghostty/WezTerm/kitty/Alacritty/Warp/Hyper/Windows Terminal/macOS Terminal/VS Code/tmux…), multiplexer, ai-maestro agent, ssh, tmux session/pane |
| `os` | OS product + version, kernel, arch, CPU, memory, uptime |
| `runtime` | CI runner, container/dev-container/WSL/sandbox, Claude Code context (entrypoint, session, VS Code integrated, plugin hook) |
| `claude` | Claude Code config dir, settings permission summary, installed plugins, `CLAUDE.md` presence, CLI version |
| `filesystem` | cwd/home/project dir, filesystem type, git repo + **worktree** (main vs linked) + branch, free disk |
| `user` | user, uid/gid, groups, shell, sudo-capable |
| `network` | interfaces, VPN (Tailscale/utun/WireGuard), proxy config, DNS, listening local ports, default gateway |
| `cloud` | AWS / Azure / GCP signals from env vars, local config, and installed CLIs (never contacts a metadata server) |
| `tooling` | installed runtimes, package managers, compilers, linters/formatters, version managers — with versions |
| `mcp` | configured MCP servers from `~/.claude.json` + the project `.mcp.json` |

The terminal detector walks the process ancestry rather than trusting `$TERM_PROGRAM` (which is inherited into subshells and goes stale across `ssh`/`sudo`/multiplexers), so it reports the *real* host. Every detector is fail-soft and time-boxes its probes — an off-cloud `aws` or a stalled `tailscale` can never wedge the report.

**Use cases:**

- **Bug reports** — attach `agentlenspro env --json --out env.json` so a maintainer sees your exact OS, terminal, tooling versions, and Claude Code context without a back-and-forth.
- **CI guards** — `agentlenspro env runtime` confirms you're on GitHub Actions / inside a container before a step runs; `agentlenspro env filesystem` tells a script whether it's in a linked git worktree vs the main checkout.
- **"Which terminal am I in?"** — `agentlenspro env terminal` disambiguates a tmux pane from its GUI host terminal (iTerm/Ghostty/…) and flags whether you're inside an ai-maestro agent or over SSH.
- **New-machine inventory** — `agentlenspro env tooling` lists every installed runtime, package manager, compiler, and linter with versions in one shot.

## Cost Estimation

The **Analytics** tab (Estimated Cost section) shows the dollar cost of Copilot, Claude Code, and Codex sessions.

**Copilot** supports three billing models via a toggle:

| Mode | Who it applies to |
| ---- | ----------------- |
| **Token-based AI Credits** (default) | Default Copilot plans from June 1, 2026 — charges per input/output/cache token at per-model rates |
| **Annual plan request-based** | Annual-plan holders staying on request billing from June 1, 2026 — multiplier × $0.04 per user-initiated prompt |
| **Request-based** *(deprecated)* | Plans on request billing before June 1, 2026 — multiplier × $0.04 per user-initiated prompt |

**Claude Code** and **Codex** always use token-based pricing — no toggle required. Claude Code is billed against the Anthropic API at standard per-token rates (input, cache write, cache read, output) depending on model (Opus, Sonnet, or Haiku). Codex is billed against the OpenAI API.

The Estimated Cost section includes a per-session bar chart with a daily aggregate line (right axis), a multi-dimensional table grouped by date and agent showing input, output, cache create, cache read, total tokens, and cost, and a model breakdown table. Included Copilot models (GPT-4.1, GPT-5 mini) show $0 under token-based billing.

All figures are estimates — not your actual bill. Rates are sourced from each provider's public pricing docs; see [PRICING_SOURCES.md](PRICING_SOURCES.md) for the authoritative URL for each billing model and notes for maintainers on keeping rates current.

### Rate-limit window budget

The burn monitor tracks each OAuth account's rolling 5h + 7d consumption and, once a window **capacity** is known, reports % consumed and a time-to-exhaustion projection (`get_window_budget` / `get_account_status` / the dashboard burn widget).

Capacity comes from one of three sources, in precedence order:

1. **Manual (env):** `AGENTLENS_WINDOW_5H_TOKENS` / `AGENTLENS_WINDOW_7D_TOKENS` (raw-token caps) or `AGENTLENS_WINDOW_5H_COST_USD` / `AGENTLENS_WINDOW_7D_COST_USD` (cost caps).
2. **Manual (file):** the same keys in `~/.agentlens/burn-config.json`.
3. **Auto-calibrated (observed):** Anthropic does not publish the raw caps, so with no manual config AgentlensPro **measures** one — when a rate-limit `StopFailure` kills a turn *before* the account's 5h window rolled, the consumption accumulated since the window started is a proven lower bound on the cap. It is persisted per account into `burn-config.json` (`observed` section) and reported as `capacitySource: "observed"` with the calibration date (`capacityObservedAt`). Observed figures only ever **ratchet up** (a later window that consumed more before limiting raises them; a smaller one proves nothing), a natural 5h rollover never calibrates (it measures elapsed time, not the cap), and any manual cap always wins — auto-calibration never touches a user-configured value.

Lifecycle hook capture (`agentlenspro --install-hooks`, or `agentlenspro setup`) is what delivers the `StopFailure` events auto-calibration listens for.

## Exporting and Importing Session Data

### Export

The **Export** tab writes session summary files to your workspace root:

- `export_sessions_<timestamp>.json` — full export including prompt text, token counts, tool usage, file changes, and cost estimates for every recorded session
- `export_sessions_<timestamp>.json` (redacted) — same structure with prompt text (`userRequest`) removed

Exports draw from the full SQLite session history, not just the active window, so all past sessions are included regardless of when they ran.

> **Note:** Session summary exports cannot be replayed with `pnpm run demo --file`. Replay requires raw OTEL span data, which is not yet persisted to disk. This is tracked as a planned enhancement.

### Import

The **Import** tab loads sessions from a previous AgentlensPro (or AgentLens) export file into the current installation — useful for migrating data to a new machine, sharing session history across team members, or restoring a local backup.

1. Open the **Import** tab in the dashboard
2. Drag-and-drop an `export_sessions_*.json` file onto the drop zone, or click **Choose file**
3. Review the preview: total sessions, breakdown by agent source, and the date range covered
4. Click **Import** — progress updates live as sessions are written; already-existing sessions are skipped automatically

Import works in standalone server mode (native process and Docker).

## Recommendations & Malfunction Detection

The **Sessions** tab (Overview sub-tab) and **Analytics** tab surface two categories of signal per session:

**Efficiency insights** — problems you can fix by adjusting your prompts:

- Context bloat (input tokens growing rapidly across turns)
- Files read multiple times, duplicate searches, large tool results
- Tool failures, high turn count, oversized starting context
- Low cache hit rate, tool definition overhead

**Loop & malfunction signals** — patterns indicating the agent is stuck or spiraling. These appear first in the list with a ↺ icon:

| Signal | Description | Trigger |
| ------ | ----------- | ------- |
| **Tool Call Deadlock** | Same tool + arguments called 3+ times (critical at 5+) | Agent not retaining tool results |
| **State Corruption Spiral** | A file edited then reverted to a prior state | Agent oscillating between conflicting constraints |
| **Hallucination Amplification Loop** | Same error recurring 3+ times | Fix attempts not resolving the root cause |
| **Ambiguous Success / Escalating Scope** | Too many steps for the task complexity | No clear completion condition |
| **Infinite Loop — Context Accumulation** | Input tokens growing while output ratio collapses 70%+ | Agent stuck, accumulating context without progress |

Each signal includes a specific recommended action and a **Copy for {Agent}** button that copies the recommendation prompt to your clipboard so you can paste it into your AI session. Use the **Ignore** button to dismiss signals that represent intentional behavior.

## Manual Configuration

Run the included setup scripts (see [Configuring Agents for Local / Docker](#configuring-agents-for-local--docker) above), or apply the settings below by hand. Replace `4318` with your custom port if you changed `OTLP_PORT`.

### GitHub Copilot

**VS Code-family IDE extension** — Add to User Settings (`Cmd+Shift+P` / `Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)*) in VS Code, Cursor, Windsurf, or any VS Code-family IDE:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"
}
```

**Copilot CLI (standalone)** — Add to your shell profile, then open a new terminal:

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

```powershell
# Windows — run once in PowerShell (persists across sessions)
[System.Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318", "User")
[System.Environment]::SetEnvironmentVariable("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true", "User")
```

---

### Claude Code

The CLI and VS Code extension both read the same file. Add to the `"env"` block:

- **macOS/Linux:** `~/.claude/settings.json`
- **Windows:** `%USERPROFILE%\.claude\settings.json`

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_USER_PROMPTS": "1"
  }
}
```

`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` enables span-level tracing — without it turns and LLM calls are indistinguishable and cache token breakdowns are unavailable. The three `OTEL_LOG_*` vars unlock tool details, file diff content (needed for the Files tab), and your typed prompt. If `settings.json` already exists, merge the `env` block — do not replace the whole file.

---

### Codex

The CLI and VS Code extension both read the same file. Add an `[otel]` section:

- **macOS/Linux:** `~/.codex/config.toml`
- **Windows:** `%USERPROFILE%\.codex\config.toml`

```toml
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }
```

`log_user_prompt = true` includes your typed prompt; without it sessions show `[session in progress]`. `exporter` sends log events; `trace_exporter` sends trace spans. Both point at the same endpoint. If `config.toml` already has an `[otel]` section, add only the missing keys.

## Local Mode Options

AgentlensPro runs as a local web server — useful on your dev machine, in CI, or on remote machines; the dashboard lives in a browser tab.

### Native process (recommended for local use)

Runs directly on your machine — no Docker required. Gives the server full access to the local filesystem, which is required for log file ingestion. Quick-start commands are in [Getting Started](#local-otel-and-log-files) above.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `OTLP_PORT` | `4318` | OTLP HTTP receiver port |
| `UI_PORT` | `3000` | Dashboard port |
| `DATA_DIR` | `~/.agentlens` | Directory for persistent span data |
| `BIND_HOST` | `127.0.0.1` | Set to `0.0.0.0` for LAN access |

Only one server can bind a given port pair at a time. To run a second instance, use different ports:

```bash
OTLP_PORT=4319 UI_PORT=3001 bunx agentlenspro
```

### Security & privacy

The dashboard and OTLP receiver bind to `127.0.0.1` by default, so they are not reachable from the network — your session data never leaves your machine. A web page you are browsing can still reach `localhost` from your own browser, so the server also refuses cross-origin browser requests: state-changing requests from a foreign origin are rejected, and responses carry `Access-Control-Allow-Origin` only for same-origin/loopback origins — a page on another site cannot read your local session data (prompts, costs, file paths). Setting `BIND_HOST=0.0.0.0` for LAN access removes the network boundary; only do so on a trusted network.

### Docker (OTEL only)

> **Log file ingestion is not available in Docker mode.** The container is isolated from the host filesystem. Use the native process option above if you need local session log history.

Quick-start commands are in [Getting Started](#docker-otel-only). Additional options:

**LAN-accessible** — exposes the dashboard to other devices on your network:

```bash
docker run --pull=always -p 3000:3000 -p 4318:4318 -v ~/.agentlens:/data agentlens/agentlens
```

**Custom ports** — if `4318` is already in use by another process:

```bash
docker run --pull=always -p 127.0.0.1:3001:3000 -p 127.0.0.1:4319:4318 \
  -v ~/.agentlens:/data \
  agentlens/agentlens
```

Then point your agents at `http://localhost:4319` and open <http://localhost:3001>.

### Node.js (from source)

Requires Node.js 18+ and this repository cloned locally.

```bash
pnpm install
pnpm run local
```

## Automation Prompts File

When an automation threshold is crossed, AgentlensPro can write the generated prompt to a markdown file. To act on it automatically, configure your agent to watch or include that file as an input — for example, by pointing Claude Code at it via a hook or referencing it in a system prompt. Without that wiring, the file serves as a persistent, reviewable log you can paste from manually. For simpler workflows, leave **Write prompts file** off and use the **Copy Prompt** notification button instead.

### How it works

When **Write prompts file** is enabled for an automation rule, each trigger appends a timestamped entry to an agent-specific file:

| Agent | File written |
| --- | --- |
| Claude Code | `agentlens-prompts-claude.md` |
| GitHub Copilot | `agentlens-prompts-copilot.md` |
| Codex | `agentlens-prompts-codex.md` |

Files are written to the directory where the server is running.

Each entry uses this format:

```markdown
## 2026-05-21 14:30:22 — Loop Breaker

[AgentLens Automation: Loop Breaker]

...generated prompt...

---
```

When **Write prompts file** is off (default), triggering an automation shows a notification with a **Copy Prompt** button instead — click it to copy the prompt to your clipboard, then paste into your agent.

## Agent Data Formats

AgentlensPro collects data from two sources per agent and normalizes both into a shared session model. The **Log** badge indicates log-file data; **OTEL** indicates telemetry data. When both are present for the same session: for Claude the log transcript wins (OTEL is a lossy lower bound; it serves only sessions with no transcript), for every other agent OTEL wins.

### Claude Code

**Log files** (automatic, no setup) — `~/.claude/projects/<project>/<session-uuid>.jsonl`

Each file is one session. `assistant` entries carry per-turn token counts (input, output, cache read/write). `user` entries carry the prompt text. Tool calls are embedded in message content blocks.

Available from logs: prompt, model, workspace, timestamps, all token counts, tool names, files read/written.
Not in logs: TTFT, per-tool latency, streaming speed, loop signals.

**OTEL** (richer, requires env config) — trace spans via `/v1/traces` and supplemental log records via `/v1/logs`.

With the recommended configuration (all three `OTEL_LOG_*` vars): prompt text, token counts, model, tool names, tool arguments, file paths, and full file diff content are all available. The three `OTEL_LOG_*` vars are not enabled by default — without them, tool arguments are absent and prompt text is omitted.

---

### Codex CLI

**Log files** (automatic, no setup) — `~/.codex/sessions/<project>/<session-uuid>.jsonl`

`turn_context` entries carry the model name. `event_msg` entries with `type: token_count` carry per-turn cumulative token usage. The user's prompt text is not present in this format.

Available from logs: model, timestamps, token counts (input, output, cache read).
Not in logs: prompt text, tool names, TTFT, latency.

**OTEL** (richer, requires config) — primarily flat OTLP log records (`/v1/logs`); adding `trace_exporter` also emits timing spans. With `log_user_prompt = true` and both exporters: prompt text, token counts, model, TTFT, tool names and results, and span timing are all present.

---

### Copilot CLI

**Log files** (automatic, no setup) — `~/.copilot/session-state/<session-uuid>/events.jsonl`

`session.start` carries the model and workspace. `user.message` carries the user prompt. `assistant.message` carries per-turn output token counts. `session.shutdown` carries total context size.

Available from logs: prompt, model, workspace, timestamps, output tokens, total context size, tool names.
Not in logs: input tokens per turn (estimated from shutdown totals), TTFT, cache token breakdown.

**OTEL** (richer, requires VS Code settings) — trace spans via Copilot's built-in OTEL exporter. Prompt text, token counts (input, output, cache read), model, TTFT, tool names, arguments, and results are all present natively. Cache write counts are not exposed — Copilot manages cache creation server-side.

---

---

### OpenCode

**SQLite database (automatic, no OTEL setup needed)** — `~/.local/share/opencode/opencode.db`

OpenCode stores all session data in a local SQLite database. AgentlensPro reads this directly — no agent configuration or OTEL setup is required. The database uses WAL (Write-Ahead Log) mode; AgentlensPro merges the WAL at read time so sessions are visible immediately after each run.

Available from the database: session ID, user prompt (last user message), model name, workspace directory, timestamps, all token counts (input, output, cache read/write), tool calls with names and inputs/outputs, file paths accessed by tools.

Not available: time-to-first-token, per-tool execution timing, streaming speed, loop detection signals, or structured error telemetry (no OTEL). Sessions show a **Log** badge and a blue info banner in the Overview tab noting these limitations.

Override the default database location with the `OPENCODE_DATA_DIR` environment variable (comma-separated for multiple directories).

---

> **Note:** Agent observability is evolving rapidly. All platforms are actively expanding what they expose, and the GenAI semantic conventions are still being standardized. AgentlensPro will be updated as richer data becomes available.

## Additional Features

- **Files Changed** — The Files tab tracks every file created or modified by the agent, organized by session with inline before/after diffs
- **Multi-session Comparison** — The Analytics tab shows per-agent breakdown cards with side-by-side token totals, cache rates, TTFT, and top tools for Copilot, Claude, and Codex
- **Automated Prompts** — The Automation tab lets you configure threshold-based automations (Loop Breaker, Turn Limit Wrap-up, Context Dump) that trigger a correction prompt when a session crosses a limit — delivered as a VS Code notification or written to a file for agent consumption

## AI Usage Disclosure

AgentlensPro — like the AgentLens project it was forked from — was built primarily with [Claude Opus](https://www.anthropic.com/claude). Thank you to Anthropic for building tools that make projects like this possible.

## License

MIT

## Disclaimer

AgentlensPro is an independent open-source project and is not affiliated with, endorsed by, or associated with GitHub, Inc. or Microsoft Corporation (GitHub Copilot); Anthropic, PBC (Claude / Claude Code); or OpenAI, LLC (Codex CLI). All product names, trademarks, and registered trademarks are the property of their respective owners. AgentlensPro interacts with these products solely through their publicly documented OpenTelemetry telemetry interfaces.
