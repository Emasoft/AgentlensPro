---
trdd-id: O981ZJKV
title: CLI cost-observability expansion — 14-item work order, coverage map + gaps
column: dev
created: 2026-07-10T12:35:54+0200
updated: 2026-07-10T13:20:00+0200
implementation-commits: [1093245, 9aa20fa, 674ed43]
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

**NEW-NOW SCOPE SHIPPED 2026-07-10** (`get_cost_rollup`, `get_rate_limit_report`, and the
late-added asks: **realtime hook switches** — `hookRuntimeConfig` + `/api/hook-config` +
`agentlens-cli --hooks gate=off|warn|enforce capture=on|off advisor=on|off`, applied
instantly machine-wide because the server is the decision point (registrations are static
per session — verified fact) — and **gate warnings on the dashboard notification panel**
via the existing SSE alert channel (deny=error, warn/advisory=warning), zero webview
changes needed. See Measured results.

ALSO SHIPPED (655a30a): **item 13 `get_runtime_inventory`** (ps-snapshot process-tree rollup;
live-verified: 2 instances, 4.0GB/21-proc + 3.4GB/16-proc trees, CC version reported;
POSIX-only with an honest native-Windows note) and the **now-focus warning directive** —
warnings speak only about current events (all windows ≤10min), past-incident storytelling
removed from texts, plus ONE future-looking clause: minutes until the CURRENT 5h/7d window
fills at the current rate (from the per-account budget projection; honest absence without
capacity config).

ALSO SHIPPED: **item 9 `predict_session_cost`** (precedent distribution p25/p50/p75, flat
headline fields; live: 12 precedents → code review $3.18 p50 / $4.72 p75).

**Item 11 CORRECTED DISPOSITION (verified 2026-07-10):** the tool ALREADY EXISTS —
`get_cost_by_cause` groups exact per-call usage by `skill`/`plugin`/`agent`/`mcpServer`/
`mcpTool` dimensions (src/tokensByCause.ts; api_request timeline entries carry
skillName/pluginName/costUsd ground truth). What's broken on THIS machine is the FEED:
`apiRequestCalls: 0` across 50 scanned sessions — the rich api_request log events aren't
reaching the session cards. So item 11 = covered-by-design, blocked by the same class of
standalone data-feed defect as the child-card linkage. ONE investigation covers both:
"why do standalone cards lack api_request timeline events and parentSessionId links?"
(Marketplace filter: not attributable — the data model has plugin, not marketplace; disclosed.)

**Windows audit blocker #1 FIXED:** python3 hardcode → platform-aware resolver
(python/py/python3 on win32; POSIX order unchanged), probed once + cached, ENOENT
fail-fast story preserved. Blockers #2/#3 (bash hook registration + bash installer) affect
NATIVE Windows only — WSL target satisfied; node-twin hook scripts are the specced fix.

STILL OPEN in this umbrella: the standalone data-feed defects investigation (child-card
links + api_request events — one session of logReader work), window-capacity
auto-calibration, native-Windows hook/installer twins, and the dashboard toggle card
(agent working on it as of 13:20). `updated:` bumped 2026-07-10T14:20.

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
- **get_cost_rollup + get_rate_limit_report SHIPPED** (suite 577 passing). Live proof of the
  rate-limit report against the real 2026-07-10 incident: 93 StopFailure turn-deaths grouped
  into ONE episode starting 09:26 local across 3 sessions (error `rate_limit`), attributed
  window verdict names FORK_STORM (3 fully cold full-prefix writes, largest 592k; 16 requests
  sharing one inherited transcript), windowEstCostUsd $167.78.
- **DEFECT found (pre-existing, blocks item 6/7 fidelity):** the standalone `getSessions()`
  path currently yields ZERO cards with `parentSessionId` (even `get_subagent_tree` reports
  childCount 0 on a session that demonstrably spawned agents). The rollup's subagent view
  honestly returns 0; the per-call fact tools (`get_cost_by_cause` byAgent,
  `compare_configs --groupBy subagent_type`) still answer subagent cost questions. Root-cause
  of the missing child-card linkage in the standalone log path = follow-up task.
- **WSL/Windows audit (item 14) complete** — report:
  `reports/cross-platform-audit/20260710_124412+0200-windows-wsl-audit.md`. Verdict: works
  MOSTLY under WSL (blockers are POSIX/bash/python3-only assumptions); native Windows has
  3 BLOCKERS — hardcoded `python3` in the sole config-editor path (safeConfigEdit), hooks
  registered as `bash spy-agentlens*.sh`, bash-only installer — plus a SIGTERM-flush
  data-loss risk (Windows has no SIGTERM graceful path) and backslash-path display bugs.
  Fixes = child TRDD when scheduled.

## Notes and lessons learned
