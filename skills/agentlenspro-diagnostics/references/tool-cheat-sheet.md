# agentlenspro-diagnostics — Tool cheat-sheet and context-composition tools

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| **"Did that compaction/command cost me a cache miss?"** | **`get_cache_event_log`** — the per-call ledger (above): peak-with-context or recent, 🔥 write magnitude, TTL tier, cache-miss reason, harness-reported cost |
| **"How full are my windows, really?"** | **`get_subscription_usage`** — Anthropic's own 5h/7d numbers + `usageCreditsEnabled` (the TTL-regime oracle) |
| **"My window drained — what burned it and WHO?"** | **`investigate_burn`** — START HERE. ONE command does the whole investigation: exact billed usage (by hour/model, est $), workspace attribution, and ranked cause findings with evidence (`FORK_STORM`, `SUBAGENT_BOOT_TAX`, `PREMIUM_MODEL_FANOUT`, `FAT_SESSION_REWRITES`, `IDLE_FLEET_KEEPWARM`, `IMAGE_BLOB_RESIDENT`, `RATE_LIMIT_COLD_RESUME`) + a plain verdict naming the culprits. Flags: `--windowHours 5` (default), `--untilIso <ISO>` for a past drain, `--maxFiles`. **Forensic — reads raw bodies off disk: if `coverage.blind` is set the verdict starts with `BLIND` and it saw nothing (capture off / dir missing / window predates capture). That is no DATA, not no BURN — cross-check with `--risk` or `get_burn_status`, which read the live feed.** Drill deeper only if needed with the tools below |
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
| **Has a session's cache EXPIRED (idle > its TTL)?** | **`agentlenspro cache-expired`** for a plain `true`/`false` a shell can branch on (`-q` → exit 0 = expired, 1 = fresh, 2 = cannot answer; it never prints `false` for a question it could not resolve). `check_cache_expiry` for the full object — idle since the last LLM request vs the per-session TTL (1h subscription-main, 5min subagent/usage-credits). Per session: `verdict` fresh\|expired\|unknown, `idleHuman`, `ttlMin`/`ttlSource`/`ttlBasis`, `lastRequestAt`. Default = **this project's** newest main session; `--all` = every session; `--sessionId <id>` = one; `--project ''` = machine-wide; `--thresholdMinutes N` overrides the TTL (e.g. `60` = "> 1h idle"). `unknown` = no LLM request recorded |
| **Is a session's cache WARM or COLD right now?** | **`agentlenspro cache-state`** — one word, `warm`/`cold`, and the exit code IS the answer (0 = warm, 1 = cold, 2 = cannot answer with stdout EMPTY — it never prints `cold` for a question it could not resolve). Cold iff the harness-reported `expires_at` has passed OR the harness itself said not-warm; the raw `warm` bit alone goes stale on an idle session. `--json` echoes the stored `prompt_cache_*` fields verbatim. |
| **How much disk space is free/used, and when exactly did it change?** | **`agentlenspro disk now`**, `disk changes --min 1G` (exact minute + signed size of each change), `disk history`, `disk trees`, or `disk sql "select …"` — recorded every minute by `agentlenspro disk-monitor install`; works with the server down and while DISABLED. See [disk-monitor.md](disk-monitor.md) |
| Biggest single cache writes + contents | `trace_expensive_writes` |
| What did the last janitor heartbeat cost? | `get_heartbeat_cost` |
| Which config (model/spawn/effort) costs most? | `compare_configs --groupBy <dim>` |
| Ad-hoc analytics over the fact DB | `run_diagnostics_sql --preset <name>` / `--sql '<SELECT…>'` |
| **Ad-hoc SQL over the raw session TRANSCRIPTS** | `run_transcript_sql` — DuckDB over the `.jsonl` records as ONE `transcripts` relation (quote camelCase columns: `"sessionId"`, `"timestamp"`). No-arg lists the presets (`record_type_histogram`, `usage_by_model`, `cache_heavy_turns`, `sessions_by_output`); `--sql '<SELECT…>'` for anything else (read-only, single statement). Bounded: `--sessionId <id>` = that one file, else `--window N` hours of mtime (default 24); coverage block names exactly what was queried. Content/shape questions no drill covers — the drills stay the fast path |
| Recent sessions / workspace patterns | `get_recent_sessions` (ranked by LAST ACTIVITY, not start date; rows carry `lastActive` + `active:true` for sessions live in the last 5min — plus the AI session `title`/`entrypoint` when the transcript carries them), `get_workspace_patterns` |
| **"Show me what was actually SAID and DONE in a session"** | `get_conversation` — the narrative reader: verbatim ordered turns (user prompt → thinking → reply → each tool call with its paired output), sidechain turns labeled, compaction dividers with pre/post/dropped tokens, per-turn duration + usage incl. cache-TTL tier 5m/1h. Progressive: no-arg = per-turn summaries; `--turn N` = that turn verbatim; `--turnFrom/--turnTo` = bounded range. Content lens; `get_context_history` stays the cost/composition lens |
| **Which sessions still write raw OTEL bodies (restart targets)?** | `get_body_writers` — ranked by recent rate then total; `active` rows wrote within `--active_min` (default 10m) and keep writing until their process restarts. Request-body attribution (responses aggregated); totals = exact store+live union. `--window_min 30 --limit 20` |
| **Who exhausted the PREVIOUS account's windows (post-rotation autopsy)?** | `get_account_burners` — BOTH the 5h and 7d tables in one call, grouped by project/agent (sessions pooled by workspace) with cache-created + cache-read columns; the window nearer its calibrated capacity at rotation is marked MOST LIKELY EXHAUSTED. Default `--account previous` (also `current`, uuid prefix, email); `--interval last`(default)`/current/<ISO-date>` picks the window end. Time-based attribution: cross-rotation sessions split correctly between accounts |
| **How long until the CURRENT account's window runs out?** | `get_window_eta` — COST-based ETA (Anthropic meters windows by cost, not tokens): consumed $ vs calibrated $ cap, current $/min, ETA + which window exhausts first. Models the rolling window — says "won't exhaust at this rate" when steady-state fill plateaus below the cap instead of a fictional countdown. Per window: `willExhaustAtCurrentRate`, `etaMinutes`/`etaHuman`, `capacity.source` (`observed` \| `same-plan-proxy`); `bindingWindow` is the string `"5h"`\|`"7d"`. `--rate_window_min 30`, `--account current`. **The preflight for any timed batch — see Budgeting a timed run** |
| **WHICH SKILL or PLUGIN is spending the money?** | `get_skill_attribution` (alias `skill-cost`) — tokens + USD per skill and per plugin from the `attributionSkill`/`attributionPlugin` stamps, exact and retroactive over all history (no hook, no OTEL). Counts usage ONCE per message id — a naive sum over-counts 2–5× (`duplicateRowsSkipped` reports the collapse). Sorted most-expensive-first. `--window N`, `--topN` |
| **What did each cache-breaking COMMAND cost?** | `get_cache_risk_costs` (alias `reload-cost`) — every prefix-breaking slash command priced exactly: `/reload-plugins`, `/reload-skills`, mutating `/plugin`, `/login`\|`/logout`, `/mcp`, `/model`. Causes are read off the transcript retroactively, not inferred; a command at T is billed on the FIRST turn at or after T. `byKind` for totals, `unexplainedReloadTurns` for co-churn inference (listed separately, never summed in). `--window`, `--kinds`, `--topN` |
| **Which plugin version is each session ACTUALLY running?** (stale-hook ghosts) | `get_loaded_plugin_versions` (alias `plugin-versions`) — a plugin update lands machine-wide but hooks/skills are SESSION-loaded, so a running session keeps executing old cached code until its own `/reload-plugins`. `loadedVersion` = MAX version observed (not latest-by-timestamp: compaction replays old skill loads as fresh records). `stale` is TRI-STATE — true \| false \| `'unknown'`. `--plugin`, `--activeMinutes`, `--staleOnly` |
| **When did this session /clear, /compact, fork, resume, or die?** | `get_lifecycle_events` — the harness events that bound and RESET a session, from the lifecycle hook store (needs `--install-hooks`). Includes StopFailure (turn death) and Pre/PostCompact; `/clear` is the cost REMEDY that resets the transcript floor. Per-turn Stop excluded by default. `--session`, `--kinds`, `--window`, `--limit`. Says `dirExists:false` honestly when the store is absent |

## Context-composition & session-drill tools

The cheat-sheet above is the burn/cost/cache core. This cluster answers "WHAT is in the context
and WHERE did it come from" — the raw-body forensics behind the dashboard's drill views. (Still:
`list --desc` is the full, never-stale index.)

| Question | Tool |
|---|---|
| WHAT occupies the context window per turn? (injected blocks: hook injections, skill/tool/agent/mcp catalogs, files) | `get_context_composition --sessionId <id>` |
| Full per-step context history from the raw `.jsonl`, every block drillable to its ACTUAL text (the cost/composition lens) | `get_context_history --sessionId <id>` |
| Cumulative context-size trajectory per turn (prompt size, cache-READ vs cache-CREATED split, new uncached) | `get_context_growth --sessionId <id>` |
| Biggest cumulative context contributors (turns × per-turn weight); flags RUNAWAY sources | `get_context_inflation_report` |
| Top context-consuming sources (files, tool outputs, rules, memories, catalogs) by cumulative token cost | `find_context_hogs` |
| Eviction-candidate finder: blocks (images, tool_results, pasted files, bash output) RESIDENT across many turns | `find_resident_blobs` |
| Generic composition query engine over the raw-body context blocks ("all possible queries") | `query_context_blocks` |
| Drill into ONE context block and return its ACTUAL text | `get_block_content` |
| The FULL literal context of ONE llm call — `{system, messages[], tools[]}` from the raw OTEL body | `get_call_context` |
| How many IMAGES a session sent + what re-reading them cost | `get_image_report` |
| Ranks WHO/WHAT burns the most of a cost BUCKET (cache_creation default; also output/input/total/billable_weighted) | `get_cache_creation_report` |
| Full timeline (LLM calls, tool calls, file edits) for one session | `get_session_detail --sessionId <id>` |
| One-call self-diagnostic for YOUR session (pass your workspace path; resolves the newest live session) | `get_session_status --workspace <path>` |
| Sub-agent spawn tree with each child's spawn-KIND (fork = cache-warm / fresh / worktree) | `get_subagent_tree --sessionId <id>` |
| Tokens-by-CAUSE attribution rollup — WHO spent the tokens | `get_cost_by_cause` |
| Diagnose prompt-cache breaks (the base report; `causes`/`timeline`/`gap` are the deeper cuts) | `get_cache_break_report` |
| Efficiency trends — are sessions getting more/less expensive; best agent/model combos; recurring problems | `get_efficiency_report` |
| Given a task, keyword-match past prompts → files accessed in similar sessions + est cost/turns | `find_relevant_context --task "<describe it>"` |
| Pending suggestions to improve a workspace's agent-instruction file (CLAUDE.md / AGENTS.md) | `get_instruction_suggestions --workspace <path>` |

Sibling PATH binary for the janitor heartbeat: `agentlenspro-heartbeat-cost --oneline` prints
the exact settled cost of the previous heartbeat fire. It ships as a bin of the agentlenspro
package, so any consumer (the janitor plugin included) invokes it by bare name — no package
paths, no repo checkout required.
