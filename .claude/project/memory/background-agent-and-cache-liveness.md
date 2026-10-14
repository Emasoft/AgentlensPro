---
name: background-agent-and-cache-liveness
description: "background agent shows running but does nothing / a fork started acting like the orchestrator / is my worker dead or hung / subagent silent for hours / transcript file not growing / liveness by transcript mtime not task alive / zombie fork stuck in a blocking call / fork mistakes itself for the orchestrator / identity anchor in the fork birth prompt / should I stop a silent subagent / does cache-expired or last-compact cost tokens / is a cache-liveness check free / how do I know if the cache is really alive / is there an API for cache liveness / cache verdict is inferred not measured / cargo test blocked under load"
ocd: 2026-07-11
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# Liveness checks — background agents and the prompt cache

Background-agent field lessons (they shaped the burn-gate rules):

- **Zombie mode**: a fork can look "running" in the UI while stuck in ONE endless blocking
  shell call — zero API turns, zero effect. Liveness = its transcript file's mtime staying
  fresh, never the task-alive status.[^1]
- **Fork identity anchor**: a fork inherits the parent's full context; after a compaction
  or a mid-life directive it can mistake itself for the orchestrator. Every fork birth
  prompt must carry an identity anchor ("you are X, never orchestrate; if the anchor is
  lost, end") — verified working: an anchored fork correctly refused an orchestration
  directive and handed it to the parent instead of acting.[^2]

^ATOM-2MG5-ACR9 [desc:"No API reports cache liveness — every freshness verdict is inferred from local evidence; cache-expired and last-compact cost zero tokens (verified 3 ways), but not zero time", keywords: does_cache-expired_cost_tokens is_the_cache_expiry_check_free how_do_I_know_if_the_cache_is_really_alive api_for_cache_liveness cache_verdict_is_inferred_not_measured zero_token_diagnostic, type: project, ocd: 2026-08-04, lmd: 2026-08-04]

There is NO API that reports whether a prompt-cache entry is still alive, so every cache-freshness verdict AgentlensPro gives is an INFERENCE from local evidence (last api_request timestamp vs the session's TTL regime) — by design, not as a shortcut. The only ground truth is to send a request and read cache_read vs cache_creation in the response, and if the cache HAD expired that probe itself pays the full rewrite, so an exact zero-cost answer is impossible in principle. Consequence: agentlenspro cache-expired and last-compact consume ZERO tokens — verified 2026-08-04 three ways: (1) the path is cacheExpiredCli -> callTool -> http://localhost:4316/mcp, and the server side is assessCacheExpiry (pure math) + getTtlContext -> getCurrentAccount -> readFileSync(~/.claude.json); (2) the three api.anthropic.com strings in the CLI bundle belong to OTHER verbs and are unreachable from these paths — /api/oauth/profile and /api/oauth/usage (subscriptionUsage.ts, account metadata) and /v1/messages/count_tokens (exactTokens.ts, ctxmap's exact measurement); (3) neither new module imports either file. Zero tokens does NOT mean zero cost: see TRDD-CXPLAT01 for the 20-40s probe latency measured the same day.

^ATOM-ZQII-NI24 [desc: "A background subagent that shows running for hours with a tiny, static transcript file is usually BLOCKED inside one long tool call (a cargo test under load), not dead — check its target artifacts' mt", keywords: background_agent_shows_running_but_does_nothing subagent_silent_for_hours transcript_file_not_growing is_my_worker_dead_or_hung should_I_stop_a_silent_subagent cargo_test_blocked_under_load_worker TaskStop_a_running_agent worker_never_answered_SendMessage target_debug_deps_mtime output_file_157_bytes agent_stuck_or_waiting kill_destroyed_a_finishing_run, type: project, trdd: TRDD-MVR6PXC0, ocd: 2026-09-05, lmd: 2026-09-05]
Measured 2026-09-05 (TRDD-MVR6PXC0): a kraken worker sat `running` for 4 h, never answered a SendMessage status ping, its transcript/output file stayed at 157 bytes from 13:50, and its edited `ui.rs` had a 13:12 mtime — every surface an orchestrator checks said "hung". It was not: the worker was inside `cargo test -p agentlens-core` under an afternoon load-avg of 16–164 (an earlier run had been OOM-killed, exit 137), and `rust-core/target/debug/deps` test binaries carried 16:51 mtimes. On this episode the output file stayed static for the whole blocked call — consistent with the harness writing the transcript only at tool-round boundaries (INFERRED, n=1; test it by spawning a worker on a 3-minute `sleep` and watching the file). Stopping it at 17:14 surfaced a complete status (split done, build 0, clippy 0, suite pending) and threw away a run that may have been minutes from green. Rule: before stopping a silent worker, read the mtimes of the artifacts its last step would produce (`ls -lt target/debug/deps | head`, the capture file it writes) and `uptime`; a fresh artifact means WAIT. A SendMessage is only answered at the worker's next tool round, so silence to a ping during a long call proves nothing. If you must stop it, say so on the card as a trade, not as a death.

## Governed by

- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — the testing and process-hygiene overview this page details.

## Notes and lessons learned

[^1]: [id:ATOM-ZOMBIE-FORK-LIVENESS, status:valid, keywords:"background_agent_shows_running_but_does_nothing zombie_fork_stuck_blocking_call liveness_by_transcript_mtime_not_task_alive", ocd:2026-07-11, lmd:2026-07-11] pinger-v4 incident: the fork collapsed a bounded
  230s tick loop into one unbounded kill-file poll; it sat "running" 4h with its
  transcript untouched. The gate's keep-warm allowance and the liveness-by-mtime rule
  come from this.
[^2]: [id:ATOM-FORK-IDENTITY-ANCHOR, status:valid, keywords:"a_fork_started_acting_like_the_orchestrator fork_mistakes_itself_for_orchestrator compaction_or_mid_life_directive identity_anchor_birth_prompt", ocd:2026-07-11, lmd:2026-07-11] promoted from the old-repo LOCAL note
  `fork-mis-resume-as-orchestrator` (a fork inherited a compaction summary and acted as a
  second orchestrator, spawning a duplicate phase agent). The anchor discipline plus the
  gate's fork rules are the guardrails.
