---
name: agentlenspro-diagnostics
description: >-
  Query AgentlensPro token/cost forensics from any project via the single global agentlenspro executable — use when
  a session is burning tokens, a rate-limit window drains too fast, the prompt cache keeps
  breaking, you need the cost of a session / heartbeat / sub-agent fleet, or any "why is this so
  expensive" question. GUARD in realtime with check_burn_risk / `--guard` (arm in a background
  monitor BEFORE agent fan-outs: warns on fan-out bursts, cold-resume risk after a rate-limit
  stall, compaction rewrites, huge-request bursts, burn spikes, and CACHE_THRASH — the prefix
  being re-written every turn instead of read). PREVENT with the burn-gate hooks
  (--install-hooks): a PreToolUse gate on agent-launch tools DENIES the four measured disaster
  launches with the reason fed back to the agent. Covers all 37 diagnostic
  tools (burn status, session burn profile, per-agent exact tokens, interval cost rollups, rate-limit forensics,
  account/plan + window budget,
  cache-break causes/timeline, expensive writes, heartbeat cost, config comparison, SQL
  analytics). START with investigate_burn — the ONE-command investigation that names the
  window-burn culprits (fork storms, premium-model fan-outs, idle-fleet keep-warm, image
  residency) ranked with evidence. Also the operations surface: the one-command idempotent
  installer/repairer (`agentlenspro setup [--dry-run] [--yes]` — detect, converge, verify each
  step, self-test), server control (`server start|stop|restart|status [--supervise]`), open the
  dashboard (`dashboard`), (re)install this skill (--install-skill), and wire/unwire Claude Code
  capture — telemetry env vars (--install-otel / --uninstall-otel) and lifecycle hook events
  (--install-hooks / --uninstall-hooks). Two server-independent local commands round it out:
  `agentlenspro config` (persist the data-retention knobs to ~/.agentlens/config.json — survives
  uninstall/upgrade; env var > file > default) and `agentlenspro env` (detect the runtime
  environment — terminal kind by process ancestry, OS, Claude Code / ai-maestro / CI / container /
  worktree context, user, network + VPN, cloud, tooling, MCP servers — one facet or one big JSON report).
---

# AgentlensPro diagnostics via the global CLI

`agentlenspro` is a PATH binary installed with the **agentlenspro** package (npm global,
npx, or Homebrew — whichever install method put it on PATH) and works from **any** project
directory. This skill deliberately relies ONLY on PATH binaries — it ships no scripts and never
references package-internal or repository paths, because the package layout differs per install
method and the CLI resolves its own package resources internally. The AgentlensPro MCP server
is deliberately NOT registered anywhere: resident MCP schemas cost ~8k tokens on every turn and
toolset changes break the prompt-cache prefix. The CLI costs zero resident tokens; its
subcommands, flags, and help come from the server's own live schemas, so it is never stale.

If `agentlenspro` is not on PATH, (re)install the package — `npm install -g agentlenspro`
(or the Homebrew formula; developers working from a checkout use `npm link`). This skill never
installs the server itself; the CLI starts it on demand.

## Commands

```bash
agentlenspro list --desc                    # every tool + one-line description
agentlenspro help <tool>                    # a tool's description + typed flags (live schema)
agentlenspro <tool> [--param value ...]     # direct call
agentlenspro call <tool> '<json-args>'      # raw JSON args object
agentlenspro batch '<json-array>'           # N tools in ONE invocation: [{"tool":"…","args":{…}}]
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
| `--purge-bodies` | delete archived body volumes proven durable in the store (each verified lump-by-lump); unproven volumes are kept and named, `.idx` sidecars always retained (the live 72h window is untouched) |
| `--risk` | one-shot realtime culprit check (~40ms REST fast path): prints only the ACTIVE burn risks, each naming the culprit session/workspace/model + magnitude |
| `--install-skill` | (re)install THIS skill into `~/.claude/skills/` — idempotent, reports installed/updated/current |
| `--install-hooks` | register the `agentlenspro hook` command string on the 10 LIFECYCLE hook events (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission, Notification, SubagentStart/Stop) AND the burn-gate (`agentlenspro gate` on PreToolUse/PostToolUse matched to `^(Task\|Agent\|Workflow\|SendMessage)$` only — see "The burn-gate" below) via the same verified transaction. Bare bin + subcommand, never absolute paths — registrations survive Homebrew version bumps; the install refuses if `agentlenspro` is not on PATH. Also migrates every previous-generation registration (`agentlenspro-hook`/`agentlenspro-gate` PATH bins, absolute-path `spy-agentlens*` scripts) and removes dead claude-spyglass entries. Never touches other tools' hooks. Idempotent; needs a session restart |
| `--uninstall-hooks` | remove exactly those agentlens hook entries — every generation: v2 command strings, v1 PATH-bin names, legacy absolute-path `spy-agentlens*` registrations (nothing else) |
| `--install-otel` | add the 19 Claude Code telemetry env vars to `~/.claude/settings.json` via a verified transaction: atomic backup+rename, cross-process lock, post-verify, refuses an unparseable file, all other content untouched, idempotent (`changed=false` when already installed) |
| `--uninstall-otel` | remove exactly those 19 vars, same guarantees |

Hook events: `--install-hooks` feeds lifecycle signals the transcripts/OTEL lack — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle — into `~/.agentlens/hook-events/` (NDJSON daily buckets, 31d retention).
Query: `GET /api/hook-events?session=&ev=&since=&until=&limit=` on the UI port.

Bodies lifecycle: raw capture is opt-in and off by default (`agentlenspro config set
captureRawBodies on|off`); when on, bodies land in a RAM-disk spool (macOS) instead of the SSD.
Live plain files (72h, `bodiesMaxAgeHours`) are ingested into a content-addressed store
(`~/.agentlens/store/` — fileless DuckDB → immutable zstd Parquet, deduped across turns,
~190× measured on this project's own history) — a source is deleted only after the store is proven
to hold its exact bytes AND its `(src_name, capture-time)` row, one gate shared by `.wad` volumes
and the hook-event spool; a payload that cannot ingest is quarantined, never deleted. The legacy monthly `.wad` archive
(`~/.agentlens/otel-bodies-archive/bodies-YYYY-MM.wad`) is a read-only fallback for history not
yet migrated, never written to again; `--export-bodies` reads from both. One server at a time:
the canonical instance owns `~/.agentlens/server.pid` and a second boot refuses cleanly.
`batch --out` files are position-prefixed (`out-1-<tool>.json`).

## Local commands — no server needed (`config`, `env`)

These two subcommands run entirely client-side (they never touch the MCP server), so they work
whether or not the server is up.

### `agentlenspro config` — persistent data retention

Retention is tunable by five `AGENTLENS_*` env vars, but env vars are ephemeral and never reach the
launchd daemon. `config` persists them to `~/.agentlens/config.json` (in the data dir, so a value set
once survives an uninstall / upgrade / CLI-path change, and the always-on daemon re-reads it every
boot). Each knob resolves at boot as **env var > config.json > built-in default**, min-floored.

```bash
agentlenspro config                              # list every knob: effective value + source (env|file|default)
agentlenspro config get spansRetentionDays       # one knob's value + where it came from
agentlenspro config set spansRetentionDays 90    # persist a change (prints "restart to apply")
agentlenspro server restart                       # apply it
```

Knobs: `spansRetentionDays` (30) · `summaryWindowHours` (24) · `bodiesMaxAgeHours` (72) ·
`bodiesMaxGb` (8) · `bodiesRetentionDays` (31) · `captureRawBodies` (off) — the one boolean knob,
`config set captureRawBodies on|off`; turning it on mounts a RAM-disk spool (macOS,
`agentlenspro spool ensure` re-creates it after a reboot) so raw bodies never touch the SSD. A
`set` on a corrupt config file REFUSES to write rather than clobbering it. Recipe — keep a year of
traces on a big disk: `agentlenspro config set spansRetentionDays 365 && agentlenspro server
restart`.

### Emergency stop: `agentlenspro disable [reason]` / `enable`

The global brake — one flag file that disarms every hook, the burn-gate, server auto-revive, and
background ingestion in **every** Claude Code session already running, on that session's next hook
fire. No restart needed (a `settings.json` edit alone cannot reach a session that already loaded
its config). `disable` also stops a running server and turns raw-body capture off; `enable` clears
the flag.

### `agentlenspro env` — environment / system detection

Reports the full nature of the environment the CLI is running in — terminal kind resolved by
**process ancestry** (not `$TERM_PROGRAM`, which lies across subshells/ssh/multiplexers). Query one
facet, or omit it for the whole report; `--out FILE` writes the full JSON to disk and prints only a
one-line digest (keep a big report out of context).

```bash
agentlenspro env                       # whole environment, human digest
agentlenspro env list                  # the 10 facets + aliases
agentlenspro env terminal              # one facet (iterm/ghostty/tmux/vscode/…, ai-maestro, ssh)
agentlenspro env --json --out env.json # full report to a file (digest to stdout) — the agent default
agentlenspro env filesystem            # git worktree (main vs linked) + branch, fs type, free disk
```

| Facet (aliases) | Reports |
|---|---|
| `terminal` (term) | host terminal by process ancestry, multiplexer, ai-maestro agent, ssh, tmux |
| `os` (system) | OS product/version, kernel, arch, CPU, memory, uptime |
| `runtime` (ci, container, context) | CI runner, container/dev-container/WSL/sandbox, Claude Code context |
| `claude` (claude-code, permissions) | config dir, settings permission summary, plugin cache, CLAUDE.md, CLI version |
| `filesystem` (fs, disk) | cwd/home/project, fs type, git repo + worktree + branch, free disk |
| `user` (account, whoami) | user, uid/gid, groups, shell, sudo-capable |
| `network` (net) | interfaces, VPN (Tailscale/utun/WireGuard), proxy, DNS, listening ports, gateway |
| `cloud` (aws, azure, gcp) | AWS/Azure/GCP via env + local config + installed CLI (never contacts a metadata server) |
| `tooling` (tools, dev) | runtimes, package managers, compilers, linters, version managers — with versions |
| `mcp` (mcp-servers) | configured MCP servers from `~/.claude.json` + project `.mcp.json` |

Use cases: attach `agentlenspro env --json --out env.json` to a bug report; in CI, `agentlenspro env
runtime` confirms you're on GitHub Actions / in a container before running; `agentlenspro env terminal`
disambiguates a tmux pane from its GUI host; `agentlenspro env tooling` inventories a fresh machine.
Every detector is fail-soft and time-boxes its probes — an off-cloud `aws` or a stalled `tailscale`
can never wedge the report.

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
   agentlenspro get_cache_break_causes --out "$REPORT_DIR/$(date +%Y%m%d_%H%M%S%z)-break-causes.json"
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
agentlenspro --risk                   # FASTEST culprit check (~40ms, REST): only the ACTIVE
                                       # risks, each naming WHO (session/workspace/model) + size
agentlenspro --guard 15               # watch loop: one [burn-guard] line per risk TRANSITION
agentlenspro check_burn_risk          # same report via MCP (full flags incl. inactive ones)
```

Every risk detail NAMES THE CULPRIT: launch/stall attribution is exact (SubagentStart /
StopFailure hook payloads carry session, workspace, agent types); thrash/fat-request
attribution reads each fat request's sender in a bounded 6KB scan and is labeled "likely" —
when nothing was attributable the message says so and points at `investigate_burn`.

**Arm the guard in a background monitor BEFORE spawning agent fan-outs, workflows, or long
batches** — each stdout line then interrupts you the moment a risk fires:

```
Monitor(command: "agentlenspro --guard 15", description: "burn guard", persistent: true)
```

| Risk | Meaning | What to DO when it fires |
|---|---|---|
| `FANOUT_BURST` | ≥5 subagents launched in 2min (hook events) | If the parent session is fat or the cache cold, STOP launching; warm with ONE agent first |
| `COLD_RESUME_RISK` | a StopFailure (rate-limit turn death) ≤10min ago | Do NOT resume a fan-out: the stall likely outlived the fan-out's cache TTL — subagents ALWAYS ride the 5-min tier (even when the main session is on the 1-hour subscription tier), so their prefixes go cold fast. Check `get_account_status` headroom, warm with one agent, then ramp |
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
   first launch IS the cache warm-up; the gate holds the rest until it lands (every fork
   resumed into a cold cache re-pays its full prefix at the write rate).
4. **FORK_STORM_FORMING** — forks of a ≥200k-token parent into a TTL-expired cache while a
   fan-out is starting: each fork re-pays the full prefix at the write rate.

Everything ambiguous is a `systemMessage` warning (cold/fat forks with the real token numbers,
fan-out heads-up with a "pin a cheaper model" hint when recent traffic is premium) or a silent
allow. A PostToolUse advisory on the same matcher injects ONE deduped in-band warning to the
model when a wave just triggered CACHE_THRASH / a fan-out burst (one per session+risk per
10min — per-call injections are themselves a cache-break cause).

Operational facts: fail-open by construction (server down = 13ms silent no-op — the gate can
never stall or fail a turn). **Switches are REALTIME and machine-wide** — `agentlenspro
--hooks` shows them, `--hooks gate=off|warn|enforce capture=on|off advisor=on|off` flips them
instantly for every running session (the server is the decision point; registrations never
change, so no restarts). Per-session escape hatch: `AGENTLENS_GATE=off` env (checked in the
hook script before any network). Thresholds tune via `AGENTLENS_GATE_FORK_FAT_TOKENS` /
`_RUNAWAY_60S` / `_FANOUT_WARN_2MIN` / `_COLD_IDLE_MS` / `_COLD_RESUME_WINDOW_MS`. Deny/warn
counts appear in `--status` and `/api/server-stats` under `gate`; every gate intervention
also lands on the dashboard's notification panel (SSE alerts). If a deny is wrong for a
legitimate mass fan-out, `agentlenspro --hooks gate=warn` for that run and restore after.

## Cache TTL tracking — a warm gap is NOT a cold rewrite (TRDD-VY1IUVUM)

The prompt-cache TTL is **not a universal 5 minutes** — a subscription MAIN session rides a **1-hour**
tier, so a 20-min gap on it is still WARM. Hardcoding 5 min made the gate/keepWarm cry "cold rewrite"
on sessions that never went cold. Every TTL number now carries a `ttlSource` so you can trust or
question it. The doc-verified matrix (`src/shared/cacheTtl.ts` — the ONE place these numbers live):

| Session kind | Auth | TTL |
|---|---|---|
| Main conversation | subscription (within plan) | **1 hour** (automatic) |
| Main conversation | subscription drawing USAGE CREDITS (over plan) | **5 min** (auto-dropped) |
| Main conversation | API key / Bedrock / GCP / Foundry | **5 min** (`ENABLE_PROMPT_CACHING_1H=1` → 1h) |
| Subagent (named/general) | any | **5 min ALWAYS** (own conversation, own cache) |
| Fork | inherits parent | reads the PARENT's entry; every hit RESETS its timer |

`FORCE_PROMPT_CACHING_5M=1` forces 5 min regardless of auth. Every cache hit resets the timer; cron
fires are main-conversation turns (they renew it).

**Reading the TTL-aware output.** `get_account_status.cacheTtl` = `{minutes, regime, ttlSource, basis}`
for your MAIN session; keepWarm/gap classifications carry `ttlAssumedMin` + `ttlSource`:
- `doc-matrix` — a matrix row applied to positively-resolved signals (trust it).
- `config` — an env override (`FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H`) decided it.
- `measured` — observed cache behaviour CONTRADICTED the assumption (a cache hit after the assumed
  expiry) and the measured floor was preferred. keepWarm's falsifier flips the source to this.
- `assumed` — a signal was absent, so the conservative 5-min floor was reported AS an assumption
  (never a silent guess).

**True cold rewrite vs normal suffix write.** A small per-turn `cache_creation` is NORMAL incremental
suffix writing. Only a **full-prefix-sized** creation spike is a real cold rewrite. Invalidation causes
≠ TTL expiry: model/effort/fast-mode switch, MCP connect/disconnect, bare-tool deny, compaction, CC
upgrade. Use `get_cache_break_gap_report` to separate TTL-expiry from a real prefix change, and
`trace_expensive_writes` for the biggest single writes + their contents.

**One-liner recipes.**
```bash
agentlenspro get_account_status                      # your session's cacheTtl regime + windowSource
agentlenspro get_cache_break_gap_report              # TTL-expiry vs real prefix change, per gap
agentlenspro get_cache_break_causes                  # what breaks the cache machine-wide
agentlenspro check_cache_expiry                      # is my cache cold yet? (newest main session)
agentlenspro check_cache_expiry --all                # every session's fresh/expired verdict
agentlenspro check_cache_expiry --thresholdMinutes 60 --out /tmp/exp.json   # probe "> 1h idle"
```

**Is a specific claude's cache expired yet?** `check_cache_expiry` answers exactly "has more than
the TTL passed since this session's last LLM request?" — idle since the last `api_request`, compared
to that session's TTL (1h subscription-main, 5min subagent/usage-credits), so `expired` means the
prefix was likely evicted and the next request pays a full cache-creation write. Per session it
returns `verdict` (fresh|expired|unknown), `idleHuman` ("1h 12m"), `ttlMin`+`ttlSource`+`ttlBasis`
(same honesty contract — unknown auth → an `assumed` 5-min floor, never a silent guess), and
`lastRequestAt`. Default = the newest MAIN session; `--all` = every session; `--sessionId <id>` = one;
`--thresholdMinutes N` overrides the TTL with an explicit cutoff (e.g. `60` to probe "more than 1h").
A `verdict:"unknown"` means no LLM request was recorded for that session.

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| **"My window drained — what burned it and WHO?"** | **`investigate_burn`** — START HERE. ONE command does the whole investigation: exact billed usage (by hour/model, est $), workspace attribution, and ranked cause findings with evidence (`FORK_STORM`, `SUBAGENT_BOOT_TAX`, `PREMIUM_MODEL_FANOUT`, `FAT_SESSION_REWRITES`, `IDLE_FLEET_KEEPWARM`, `IMAGE_BLOB_RESIDENT`, `RATE_LIMIT_COLD_RESUME`) + a plain verdict naming the culprits. Flags: `--windowHours 5` (default), `--untilIso <ISO>` for a past drain, `--maxFiles`. Drill deeper only if needed with the tools below |
| Is something burning RIGHT NOW? | `get_burn_status` |
| Which account am I on — email, plan (Pro/Max 5x/Max 20x), billing MODE, cache-TTL regime, 5h/7d fill? | `get_account_status` — one-line `summary` + `plan`/`mode`/`cacheTtl {minutes,regime,ttlSource}`/`usageWindows {fiveHourPct,sevenDayPct,windowSource}` (windowSource `cc-rate-limits` when Claude Code's own rate_limits are ingested, else `calibrated`, else `none` — a null is never shown as 0) |
| What account/mode/plan/cache-TTL was I on at a PAST instant T? | `get_account_state_at --ts <ms-epoch>` (or `--iso <ISO-8601>`) — binary-searches the change-detected account-state timeline (`~/.agentlens/account-state.ndjson`, written ONLY on a discrete state change, ~a few writes/hour), so you can attribute a past span/burn to the mode+plan+TTL in force then. Null (never fabricated) when the timeline doesn't reach that far back |
| How much 5h/7d window is left, per account, and when does it run out? | `get_window_budget` (time-to-exhaustion needs `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` capacity configured — calibrate from a premature window end) |
| What did project X / ALL projects / my subagents cost in interval Y? (5-value breakdown + $/h) | `get_cost_rollup --groupBy project\|all\|subagent\|session\|model --windowHours N` (or `--sinceIso/--untilIso`); `--subagentsOnly --liveOnly` = the live-fleet view; `--sortBy` any bucket |
| What rate limits did I hit, what EXACTLY filled the window, and why? | `get_rate_limit_report` — stall episodes (sessions/workspaces/errors) + the newest episode's 5h window attributed with exact billed usage, verdict, and top findings |
| What will this code review / workflow COST before I launch it? | `predict_session_cost --task "<describe it>"` (+ `--subagentType`, `--fileBytes`) — p25/p50/p75 over matched real precedents; p75 = budget-safe |
| Which Claude Code instances are running and what memory does EACH one's whole tree use? | `get_runtime_inventory` — instances ranked by total tree RSS (subshells/agents/crons/servers included), project dir, CC version |
| Why is THIS session expensive? | `get_session_burn_profile --sessionId <id>` |
| Exactly what did agent X consume? (reconcile with CC's per-agent ↓ footer) | `get_agent_tokens --agentId <id>` (bare / `agent-<id>` / full sessionId, case-insensitive; `--parentSessionId` to disambiguate — ambiguity errors listing candidates, never guesses). Exact four buckets + cost_usd. **CC's ↓ display shows live context-read volume (cumulative input+cacheRead+cacheCreation, launch turn included), not billing — reconcile via `ccDisplayEquivalent`** |
| What keeps breaking the cache, machine-wide? | `get_cache_break_causes` |
| Per-turn break diagnosis of one session | `get_cache_break_timeline --sessionId <id>` |
| TTL expiry vs real prefix change? | `get_cache_break_gap_report` |
| **Has a session's cache EXPIRED (idle > its TTL)?** | `check_cache_expiry` — idle since the last LLM request vs the per-session TTL (1h subscription-main, 5min subagent/usage-credits). Per session: `verdict` fresh\|expired\|unknown, `idleHuman`, `ttlMin`/`ttlSource`/`ttlBasis`, `lastRequestAt`. Default = newest main session; `--all` = every session; `--sessionId <id>` = one; `--thresholdMinutes N` overrides the TTL (e.g. `60` = "> 1h idle"). `unknown` = no LLM request recorded |
| Biggest single cache writes + contents | `trace_expensive_writes` |
| What did the last janitor heartbeat cost? | `get_heartbeat_cost` |
| Which config (model/spawn/effort) costs most? | `compare_configs --groupBy <dim>` |
| Ad-hoc analytics over the fact DB | `run_diagnostics_sql --preset <name>` / `--sql '<SELECT…>'` |
| Recent sessions / workspace patterns | `get_recent_sessions`, `get_workspace_patterns` |
| **Which sessions still write raw OTEL bodies (restart targets)?** | `get_body_writers` — ranked by recent rate then total; `active` rows wrote within `--active_min` (default 10m) and keep writing until their process restarts. Request-body attribution (responses aggregated); totals = exact store+live union. `--window_min 30 --limit 20` |
| **Who exhausted the PREVIOUS account's windows (post-rotation autopsy)?** | `get_account_burners` — BOTH the 5h and 7d tables in one call, grouped by project/agent (sessions pooled by workspace) with cache-created + cache-read columns; the window nearer its calibrated capacity at rotation is marked MOST LIKELY EXHAUSTED. Default `--account previous` (also `current`, uuid prefix, email); windows end at the rotation-out moment. Time-based attribution: cross-rotation sessions split correctly between accounts |

Sibling PATH binary for the janitor heartbeat: `agentlenspro-heartbeat-cost --oneline` prints
the exact settled cost of the previous heartbeat fire. It ships as a bin of the agentlenspro
package, so any consumer (the janitor plugin included) invokes it by bare name — no package
paths, no repo checkout required.
