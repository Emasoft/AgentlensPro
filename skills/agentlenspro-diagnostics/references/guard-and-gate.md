# agentlenspro-diagnostics — Realtime guard and the burn-gate

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

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
Monitor(command: "agentlenspro --guard 15", description: "burn guard", timeout_ms: 1800000)
```

For a batch with a known duration (a test round, a sweep), the guard is only half the job — it
watches the *rate*. Run the preflight in **Budgeting a timed run** below first to learn whether the
window survives the run at all, and to get the abort condition.

**Monitor is not always available, and the failure is silent** — per the Claude Code tools
reference it does not exist on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry,
nor when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (a plausible
combination on a machine running a telemetry product). It also inherits **Bash** permission rules,
so a restrictive allowlist can deny `agentlenspro` here exactly as it would in a shell. When
Monitor is unavailable, do not skip the guard — poll it instead: `agentlenspro --risk` is a ~40ms
REST call printing only the ACTIVE risks, so a checkpoint in your own loop (step 3 below) covers
the same ground without the tool.

| Risk | Meaning | What to DO when it fires |
|---|---|---|
| `FANOUT_BURST` | ≥5 subagents launched in 2min (hook events) | If the parent session is fat or the cache cold, STOP launching; warm with ONE agent first |
| `COLD_RESUME_RISK` | a StopFailure (rate-limit turn death) ≤10min ago | Do NOT resume a fan-out: the stall likely outlived the fan-out's cache TTL — subagents ALWAYS ride the 5-min tier (even when the main session is on the 1-hour subscription tier), so their prefixes go cold fast. Check `get_account_status` headroom, warm with one agent, then ramp |
| `COMPACTION_REWRITE` | PreCompact ≤5min ago | The next turn rewrites the full prefix; avoid fan-outs/model switches until warm |
| `HUGE_REQUEST_BURST` | ≥3 requests >1MB in 90s | A fat-context fan-out is IN FLIGHT — stop adding agents, let the wave settle |
| `BURN_SPIKE` | live burn > 250k tokens/min (5-min window) | Run `investigate_burn --windowHours 1` NOW to name the source before it drains the window. The flag reports rate, **not** time-left (it says `Window time-left unavailable` without calibrated capacity) — pair it with `get_window_eta` to learn whether the window actually survives the run |
| `CACHE_THRASH` | ≥3 responses in 5min from ONE session's own prefix (1h-tier or untiered) with big `cache_creation` and ~zero `cache_read` (exact Anthropic usage); 5m-tier writes — a subagent's boot or its own turn-2 rewrite — are reported separately as `subagentWrites` and never count | The CALLER's prefix is being INVALIDATED every turn. Not a fork on Claude Code ≥ 2.1.257 (a fork reads the caller's last-written entry warm — measured on 2.1.261: cache_read ≈ the parent's whole context, cache_creation 1–3k; older builds may cold-write it) and not the workers' boots — the row's `API cache_miss_reason` histogram names what the API saw (`previous_message_not_found`, `system_changed`, …). Blind spot: on a usage-credits account main turns are 5m-tier too, so they land in `subagentWrites` and this row sees only untiered (old-build) bodies — read `subagentWrites` there; `get_subscription_usage`'s `usageCreditsEnabled` says which regime you are on. `investigate_burn --windowHours 1` then `get_cache_break_causes` to name the mutator |

Hook-event risks need `--install-hooks` (the `sources` block says which feeds are absent).
Known burn multipliers to avoid up front: fan-outs forked from a fat session (compact first),
resuming a fan-out right after a rate-limit stall, a `/model` switch to a premium default
before spawning fresh agents, and images left resident in context.

## The burn-gate — PREVENTION, not just warning (installed by `--install-hooks`)

Warnings only work if someone is watching. The gate acts by itself: a PreToolUse hook on
`^(Task|Agent|Workflow|SendMessage|Read)$` asks the
resident server before every launch (one curl, measured 14ms end-to-end, decision p50 0.9ms)
and **DENIES the four measured disaster signatures**, feeding the reason back to the agent so
it can adapt instead of just failing:

1. **THRASH_ACTIVE** — cache-thrash in progress in the CALLER's own turns. A warn, never a deny for a fork or a fresh agent (neither is the cause: a fork reads the caller's last-written entry, a fresh agent boots its own prefix); the message carries the API's own `cache_miss_reason` histogram. Fix the source — the caller's next turns keep re-writing until then.
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

**`Read` is in the matcher for ONE thing: the image cache-guard**, which WARNS (never denies)
when the file being read is an image and the session context is already ≥`imgWarnTokens` (50k).
An image block is RESIDENT — it rides forward in the prefix and is re-billed on every later turn
until a compaction evicts it — so the reason names the cheaper paths: delegate the look to a
subagent, batch every image into ONE turn, write the verdict down instead of re-reading. It is
warn-only on purpose, and MEASUREMENT has since settled the question in that direction: reading
eight full-size images one per turn produced seven consecutive appends with zero invalidations
(`cache_creation` flat at the image's own size, `cache_read` growing by exactly that much), so the
popular "an image invalidates the whole message cache" claim is false for an APPEND and must not
become a deny on a hot-path tool. `Read` is also the only non-rare tool in the matcher, and its
cost is bounded on the CLI side — a NON-image read is answered locally with one JSON parse and no
network call. Switch it off alone with `--hooks cacheguard=off` or `AGENTLENS_CACHE_GUARD=off`;
the agent-launch gate stays armed. Deeper discipline: the `agentlenspro-cache-guard` skill.

Operational facts: fail-open by construction (server down = 13ms silent no-op — the gate can
never stall or fail a turn). **Switches are REALTIME and machine-wide** — `agentlenspro
--hooks` shows them, `--hooks gate=off|warn|enforce capture=on|off advisor=on|off
cacheguard=on|off` flips them
instantly for every running session (the server is the decision point; registrations never
change, so no restarts). Per-session escape hatch: `AGENTLENS_GATE=off` env (checked in the
hook script before any network). Thresholds tune via `AGENTLENS_GATE_FORK_FAT_TOKENS` /
`_RUNAWAY_60S` / `_FANOUT_WARN_2MIN` / `_COLD_IDLE_MS` / `_COLD_RESUME_WINDOW_MS` /
`_IMG_WARN_TOKENS` / `_IMG_DENY_TOKENS`. Deny/warn
counts appear in `--status` and `/api/server-stats` under `gate`; every gate intervention
also lands on the dashboard's notification panel (SSE alerts). If a deny is wrong for a
legitimate mass fan-out, `agentlenspro --hooks gate=warn` for that run and restore after.

