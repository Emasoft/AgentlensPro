---
name: hook-burn-gate
description: "why does the burn gate deny an agent launch / why is PreToolUse hooked only for Task Agent and Workflow / why not hook every PreToolUse and PostToolUse / burn-gate blocked my fork / fork denied by runaway fan-out / review fork refused by the agentlens gate / 8 subagent launches in the last 60s / THRASH_ACTIVE RUNAWAY_FANOUT COLD_RESUME_FANOUT FORK_STORM_FORMING denied / AGENTLENS_GATE=off kill switch / AGENTLENS_GATE_MODE=warn downgrade / spy-agentlens-gate.sh sync hook / agent-gate endpoint latency / gate fails open on error / additionalContext advisory once per session per risk / per-tool-call hooks cause cache-break damage / why is the gate blocking fork agents"
ocd: 2026-07-10
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# Burn gate — the one narrow PreToolUse hook

^LF0R1X1S [desc:"why PreToolUse/PostToolUse/UserPromptSubmit are not hooked, except the narrow burn-gate exception on Task/Agent/Workflow that denies four measured disaster launch patterns", keywords:"why_not_pretooluse_posttooluse_hooked per_tool_call_hook_overhead_and_cache_break burn_gate_exception_task_agent_workflow_matcher spy_agentlens_gate_sh sync_hook_denies_agent_launch agent_gate_endpoint_latency thrash_active_runaway_fanout_cold_resume_fanout_fork_storm_forming agentlens_gate_kill_switch agentlens_gate_mode_warn", ocd:2026-07-10, lmd:2026-09-05]
**Deliberately NOT hooked unmatched: PreToolUse/PostToolUse/UserPromptSubmit** — fully
redundant with existing ingestion, and per-tool-call hooks are where all overhead and all
cache-break damage lives (additionalContext reminders get stripped in place mid-transcript →
prefix re-bill; that mechanism measured at ≈44% of cache-break waste, see the CHANGELOG 0.9.0
context).[^1] **The ONE narrow exception (TRDD-GOD0108C, 0.10.0): the burn-gate** —
`scripts/spy-agentlens-gate.sh` on PreToolUse/PostToolUse **matched to `^(Task|Agent|Workflow)$`
only** (agent launches are rare). SYNC (async hooks cannot deny), 3s timeout, one curl to
`POST /api/agent-gate` (decision p50 0.9ms, end-to-end 14ms), fail-open on any error,
`AGENTLENS_GATE=off` kill-switch, `AGENTLENS_GATE_MODE=warn` downgrade. It denies the four
measured disaster launches (THRASH_ACTIVE / RUNAWAY_FANOUT / COLD_RESUME_FANOUT /
FORK_STORM_FORMING) with the reason fed back to the model; PostToolUse injects ONE deduped
additionalContext advisory per session+risk per 10min. See the burn-gate docs in
the skill (no dedicated memory page yet on this machine).

^ATOM-FIS4-EY4J [desc: "The burn-gate's RUNAWAY_FANOUT rule (≥8 SubagentStarts machine-wide in 60s) never DENIES a fork (TRDD-3EZ6SJ2Z, in the working tree 2026-09-05, gates/commit/deploy pending — update this line when live", keywords: burn-gate_blocked_my_fork fork_denied_runaway_fan-out review_fork_refused_by_agentlens_gate 8_subagent_launches_in_the_last_60s RUNAWAY_FANOUT_fork stop_hook_review_fork_blocked why_is_the_gate_blocking_fork_agents fork_reuses_parent_context_no_cache_build machine-wide_launch_count fresh_agent_denied_fork_allowed AGENTLENS_GATE=off_fork agentGate.ts_runaway60s, type: project, trdd: TRDD-3EZ6SJ2Z, ocd: 2026-09-05, lmd: 2026-09-05]
**Status 2026-09-05 16:37: LIVE. TS twin `52155adf`, Rust twin `10715a00` (route test 1/0), release alcore built, `codesign -s - --force`d and running as the collector since 16:37 (`bin-native/darwin-arm64/alcore`, `--version` exit 64 = usage, not 137). Not yet observed on a real ≥8/60 s wave — the first such fork launch will show the warn instead of the deny.** `RUNAWAY_FANOUT` counts SubagentStart events MACHINE-WIDE (all sessions, all projects) over 60 s and denies at ≥8 (`runaway60s`, env `AGENTLENS_GATE_RUNAWAY_60S`). The deny was type-blind, so a stop-hook review FORK was refused whenever OTHER sessions' fresh spawns filled the window — the gate blocked its own mandated review (USER report, TRDD-3EZ6SJ2Z). Fix in both twins (`src/agentGate.ts` runaway branch, `rust-core/…/burn/agent_gate.rs`): `subagent_type == "fork"` (and not the keep-warm pinger) returns `decision: warn`, `code: RUNAWAY_FANOUT`, reason "This fork is allowed: it reads the caller's cache entry and writes no new prefix"; non-forks keep the deny. Basis: the TRDD-DIZ289UQ measurement already used for the THRASH rule (a fork's first request is a warm read, cache_creation 1–3k vs 380k–785k read). The fat-parent-into-COLD-cache fork case keeps its own two rules. The count still includes forks — only the DENY is fork-exempt. Live only after the Rust rebuild + codesign + `agentlenspro server restart` (alcore serves `/api/agent-gate`).

## Governed by

- [[hook-events-pipeline]] — the hook pipeline overview this page details (what is hooked, what is deliberately not).

## Notes and lessons learned

[^1]: [id:ATOM-BUCKET-NAME-NAN-AND-STOP-HOOK-EXIT, status:valid, keywords:"stop_hook_error_every_turn bucket_name_regex_matches_calendar_invalid_dates NaN_defeats_purge happy_path_must_exit_0_on_absent_optional_input", ocd:2026-07-10, lmd:2026-07-10] Two field lessons from shipping this. (a) The
  bucket-name regex \d{4}-\d{2}-\d{2} also matches calendar-invalid names ('2026-13-99' →
  NaN, '2026-02-31' overflows): NaN silently defeated BOTH the read fast-path and the
  string-compare purge — an unpurgeable file counted forever. Fixed with bucketDayMs()
  round-trip validation (a5b3519); parse dates once, validate by round-trip, compare
  numerically. (b) AgentLens's own pending-prompt Stop hook '[ -f "$f" ] && cat …' exited 1
  on every turn with no pending file → a "Stop hook error" banner every turn (a073e3d). A
  hook's happy path must be exit 0: absent-optional-input is the NORMAL case, not an error.
