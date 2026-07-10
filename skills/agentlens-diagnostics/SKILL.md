---
name: agentlens-diagnostics
description: >-
  Query AgentLens token/cost forensics from any project via the global agentlens-cli — use when
  a session is burning tokens, a rate-limit window drains too fast, the prompt cache keeps
  breaking, you need the cost of a session / heartbeat / sub-agent fleet, or any "why is this so
  expensive" question. GUARD in realtime with check_burn_risk / `--guard` (arm in a background
  monitor BEFORE agent fan-outs: warns on fan-out bursts, cold-resume risk after a rate-limit
  stall, compaction rewrites, huge-request bursts, burn spikes, and CACHE_THRASH — the prefix
  being re-written every turn instead of read). PREVENT with the burn-gate hooks
  (--install-hooks): a PreToolUse gate on agent-launch tools DENIES the four measured disaster
  launches with the reason fed back to the agent. Covers all 36 diagnostic
  tools (burn status, session burn profile, interval cost rollups, rate-limit forensics,
  account/plan + window budget,
  cache-break causes/timeline, expensive writes, heartbeat cost, config comparison, SQL
  analytics). START with investigate_burn — the ONE-command investigation that names the
  window-burn culprits (fork storms, premium-model fan-outs, idle-fleet keep-warm, image
  residency) ranked with evidence. Also the operations surface: start the server (--start-server), open the
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
| `--risk` | one-shot realtime culprit check (~40ms REST fast path): prints only the ACTIVE burn risks, each naming the culprit session/workspace/model + magnitude |
| `--install-skill` | (re)install THIS skill into `~/.claude/skills/` — idempotent, reports installed/updated/current |
| `--install-hooks` | register `spy-agentlens.sh` on the 10 LIFECYCLE hook events (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission, Notification, SubagentStart/Stop) AND the burn-gate (`spy-agentlens-gate.sh` on PreToolUse/PostToolUse matched to `^(Task\|Agent\|Workflow)$` only — see "The burn-gate" below) via the same verified transaction; also removes dead claude-spyglass entries. Never touches other tools' hooks. Idempotent; needs a session restart |
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

## Realtime guard — arm it BEFORE anything that can explode

Token explosions have warning signs MINUTES before the window drains, and the server sees
them in realtime (OTLP metrics tick every 4s; raw request bodies land as files at call time;
lifecycle hook events — SubagentStart/StopFailure/PreCompact — arrive within ~1s when
`--install-hooks` is active). `check_burn_risk` fuses them into 5 flags; `--guard` watches:

```bash
agentlens-cli --risk                   # FASTEST culprit check (~40ms, REST): only the ACTIVE
                                       # risks, each naming WHO (session/workspace/model) + size
agentlens-cli --guard 15               # watch loop: one [burn-guard] line per risk TRANSITION
agentlens-cli check_burn_risk          # same report via MCP (full flags incl. inactive ones)
```

Every risk detail NAMES THE CULPRIT: launch/stall attribution is exact (SubagentStart /
StopFailure hook payloads carry session, workspace, agent types); thrash/fat-request
attribution reads each fat request's sender in a bounded 6KB scan and is labeled "likely" —
when nothing was attributable the message says so and points at `investigate_burn`.

**Arm the guard in a background monitor BEFORE spawning agent fan-outs, workflows, or long
batches** — each stdout line then interrupts you the moment a risk fires:

```
Monitor(command: "agentlens-cli --guard 15", description: "burn guard", persistent: true)
```

| Risk | Meaning | What to DO when it fires |
|---|---|---|
| `FANOUT_BURST` | ≥5 subagents launched in 2min (hook events) | If the parent session is fat or the cache cold, STOP launching; warm with ONE agent first |
| `COLD_RESUME_RISK` | a StopFailure (rate-limit turn death) ≤10min ago | Do NOT resume a fan-out: the stall outlived the 5-min cache TTL — check `get_account_status` headroom, warm with one agent, then ramp |
| `COMPACTION_REWRITE` | PreCompact ≤5min ago | The next turn rewrites the full prefix; avoid fan-outs/model switches until warm |
| `HUGE_REQUEST_BURST` | ≥3 requests >1MB in 90s | A fat-context fan-out is IN FLIGHT — stop adding agents, let the wave settle |
| `BURN_SPIKE` | live burn > 250k tokens/min (5-min window) | Run `investigate_burn --windowHours 1` NOW to name the source before it drains the window |
| `CACHE_THRASH` | ≥3 responses in 5min with big `cache_creation` and ~zero `cache_read` (exact Anthropic usage) | The prefix is being INVALIDATED every turn — a subagent/fork or a prefix-mutating tool is re-billing the whole context per call. STOP launching agents; `investigate_burn --windowHours 1` then `get_cache_break_causes` to name the mutator |

Hook-event risks need `--install-hooks` (the `sources` block says which feeds are absent).
Known burn multipliers to avoid up front: fan-outs forked from a fat session (compact first),
resuming a fan-out right after a rate-limit stall, a `/model` switch to a premium default
before spawning fresh agents, and images left resident in context.

## The burn-gate — PREVENTION, not just warning (installed by `--install-hooks`)

Warnings only work if someone is watching. The gate acts by itself: a PreToolUse hook on
`^(Task|Agent|Workflow)$` (agent-launch tools ONLY — never per-tool-call overhead) asks the
resident server before every launch (one curl, measured 14ms end-to-end, decision p50 0.9ms)
and **DENIES the four measured disaster signatures**, feeding the reason back to the agent so
it can adapt instead of just failing:

1. **THRASH_ACTIVE** — cache-thrash in progress: launching more agents multiplies the re-billing.
2. **RUNAWAY_FANOUT** — ≥8 launches in 60s: let the wave settle.
3. **COLD_RESUME_FANOUT** — a rate-limit stall just ended and one agent already launched: that
   first launch IS the cache warm-up; the gate holds the rest until it lands (the 2026-07-10
   incident was 14 forks resumed into a cold cache = 883k tokens in 33s).
4. **FORK_STORM_FORMING** — forks of a ≥200k-token parent into a TTL-expired cache while a
   fan-out is starting: each fork re-pays the full prefix at the write rate.

Everything ambiguous is a `systemMessage` warning (cold/fat forks with the real token numbers,
fan-out heads-up with a "pin a cheaper model" hint when recent traffic is premium) or a silent
allow. A PostToolUse advisory on the same matcher injects ONE deduped in-band warning to the
model when a wave just triggered CACHE_THRASH / a fan-out burst (one per session+risk per
10min — per-call injections are themselves a cache-break cause).

Operational facts: fail-open by construction (server down = 13ms silent no-op — the gate can
never stall or fail a turn); `AGENTLENS_GATE=off` disables it entirely (checked before any
network); `AGENTLENS_GATE_MODE=warn` downgrades every deny to a warning; thresholds tune via
`AGENTLENS_GATE_FORK_FAT_TOKENS` / `_RUNAWAY_60S` / `_FANOUT_WARN_2MIN` / `_COLD_IDLE_MS` /
`_COLD_RESUME_WINDOW_MS`; hook changes need a session restart. Deny/warn counts appear in
`/api/server-stats` under `gate`. If a deny is wrong for a legitimate mass fan-out, don't
fight it turn-by-turn — set `AGENTLENS_GATE_MODE=warn` for that run and restore after.

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| **"My window drained — what burned it and WHO?"** | **`investigate_burn`** — START HERE. ONE command does the whole investigation: exact billed usage (by hour/model, est $), workspace attribution, and ranked cause findings with evidence (`FORK_STORM`, `SUBAGENT_BOOT_TAX`, `PREMIUM_MODEL_FANOUT`, `FAT_SESSION_REWRITES`, `IDLE_FLEET_KEEPWARM`, `IMAGE_BLOB_RESIDENT`, `RATE_LIMIT_COLD_RESUME`) + a plain verdict naming the culprits. Flags: `--windowHours 5` (default), `--untilIso <ISO>` for a past drain, `--maxFiles`. Drill deeper only if needed with the tools below |
| Is something burning RIGHT NOW? | `get_burn_status` |
| Which account am I on — email, plan (pro/max5x/max20x), billing (subscription vs API), extra-usage? | `get_account_status` |
| How much 5h/7d window is left, per account, and when does it run out? | `get_window_budget` (time-to-exhaustion needs `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` capacity configured — calibrate from a premature window end) |
| What did project X / ALL projects / my subagents cost in interval Y? (5-value breakdown + $/h) | `get_cost_rollup --groupBy project\|all\|subagent\|session\|model --windowHours N` (or `--sinceIso/--untilIso`); `--subagentsOnly --liveOnly` = the live-fleet view; `--sortBy` any bucket |
| What rate limits did I hit, what EXACTLY filled the window, and why? | `get_rate_limit_report` — stall episodes (sessions/workspaces/errors) + the newest episode's 5h window attributed with exact billed usage, verdict, and top findings |
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
