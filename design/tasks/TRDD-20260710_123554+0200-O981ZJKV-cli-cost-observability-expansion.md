---
trdd-id: O981ZJKV
title: CLI cost-observability expansion — 14-item work order, coverage map + gaps
column: dev
created: 2026-07-10T12:35:54+0200
updated: 2026-07-10T12:35:54+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 1
effort: XL
labels: [cli, cost, accounts, subagents, rate-limits, cross-platform]
parent-trdd: null
npt: []
eht: []
test-requirements: [unit, typecheck, lint]
---

# 14-item cost-observability work order (2026-07-10)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-10

**IN DEV.** The user's full 14-item list is recorded below with dispositions. This session
ships items marked NEW-NOW; BACKBURNER items get child TRDDs when picked up — their specs
live in this file so nothing is lost.

## Coverage map (verified against the live 34-tool surface, 2026-07-10)

| # | Ask | Disposition |
|---|---|---|
| 1 | Active account: email, oauth-subscription vs api-token vs extra-usage, pro/max5x/max20x | **COVERED** — `get_account_status` returns email, `billingType: stripe_subscription`, `hasExtraUsageEnabled`, `rateLimitTier: default_claude_max_20x` (live-verified). Document in skill |
| 2 | 5h/7d window cost extrapolation + exhaustion clock + time left (subscription mode only) | **COVERED w/ CONFIG** — `get_window_budget` projects time-to-exhaustion PER account but needs `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` capacity config (raw caps are not published by Anthropic; calibrate from a premature window end). Mode-gating: billingType is available to suppress in api-token mode. Document; capacity auto-calibration = BACKBURNER child |
| 3 | Session usage rate + cost, 5-value breakdown, current agent + any tracked-project agent | **COVERED** — `get_session_status` (resolve own session by workspace), `get_session_burn_profile --sessionId`, `get_recent_sessions`; cards carry input/output/cacheRead/cacheCreate + derived cost (unpriced labeled) |
| 4 | Project cost in a time interval, 5 values | **NEW-NOW** — `get_cost_rollup --groupBy project --windowHours N` |
| 5 | All projects combined in an interval, 5 values | **NEW-NOW** — same tool, `--groupBy all` |
| 6 | Live subagents of the main claude, 5-value rates | **NEW-NOW** — same tool, `--subagentsOnly true --liveOnly true` (+ `--parentSessionId` to scope to one main agent); live = card still receiving turns |
| 7 | All subagents' historical costs, ranked/sorted by the 5 values, spawn-time filter | **NEW-NOW** — same tool, `--groupBy subagent --sortBy <bucket>` |
| 8 | Single subagent by id, 5 values | **COVERED** — `get_session_burn_profile --sessionId <agentId>` (child cards use sessionId=agentId); also rollup `--groupBy session --parentSessionId` |
| 9 | Predict next similar-session cost (code reviews, ultracode workflows) | **BACKBURNER child** — extend `find_relevant_context` (already returns similar-session estimated cost/turns) with spawnSubagentType + input-size similarity + a variance band. Spec: match on (subagent_type, task keywords, Σ files-read bytes decile); return p25/p50/p75 of matched sessions' 5 values |
| 10 | Worst-offender subagents + tool calls by the 5 values, tool-type filter | **MOSTLY COVERED** — `get_cost_by_cause` (byAgent/byTool dims), `get_cache_creation_report` (bucket ranking), `trace_expensive_writes`. Document the recipe; add tool-type filter only if a real query fails |
| 11 | Average cost of SKILLS, ranked by 5 values, filtered by session/project/agent/skill/plugin/marketplace + interval | **BACKBURNER child** — needs a skill-invocation dimension at ingestion (Skill tool_use inputs carry the skill name; plugin/marketplace resolvable from the skill path). Then a `groupBy skill` in cost_by_cause |
| 12 | Rate-limit error report: exact tokens of the requests that filled the window, per episode, + heuristic culprit diagnosis | **NEW-NOW** — `get_rate_limit_report`: StopFailure hook events grouped into stall episodes (session/cwd/error verbatim), most-recent episode attributed by running the investigate_burn scan for the 5h window ENDING at the stall (exact billed response usage + ranked findings) |
| 13 | Runtime inventory: model, CC client version, memory of THIS instance + every dependent process (subshells/worktrees/subagents/forks/plugin crons/background), other instances, rank by memory | **BACKBURNER child** — new `get_runtime_inventory`: ps snapshot → process tree rooted at each `claude` main process (pid/ppid walk), RSS rollup per instance, session_id↔pid join via hook events' cwd + transcript mtimes; CC version via `claude --version`; model via statusline/last response. Needs a Windows-safe ps strategy |
| 14 | Cross-platform: Windows + WSL safety for the whole of AgentLens | **DELEGATED** — read-only audit agent running (reports/cross-platform-audit/); fixes land as a child TRDD from its findings |

## Ships in this TRDD (NEW-NOW)

1. **`get_cost_rollup`** — one tool for items 4/5/6/7: window filter (`windowHours` or
   `sinceIso`/`untilIso`), `groupBy project|session|subagent|model|all`, filters
   `subagentsOnly`, `parentSessionId`, `liveOnly`; per group the 5 values
   (input/output/cacheRead/cacheCreation/costUsd) + tokens-and-$ per hour + share; totals;
   `sortBy` any bucket. HONESTY: cards are session-granular — a session counts when it
   OVERLAPS the window, token totals are whole-session (disclosed in `coverage`); unpriced
   sessions excluded from $ and counted separately, never silent $0.
2. **`get_rate_limit_report`** — item 12 as specced above.

## Measured/verified results

- Item 1/2 verification calls recorded 2026-07-10: account_status returns the full identity
  block; window_budget works but capacity unconfigured on this machine (capacitySource:none).
- (rest pending implementation)

## Notes and lessons learned
