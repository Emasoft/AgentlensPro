---
name: hook-events-pipeline
description: "how does AgentLens capture Claude Code lifecycle events / where do StopFailure PreCompact SessionStart events come from / what is spy-agentlens.sh / hook-events store, --install-hooks, why not PreToolUse / Stop hook error every turn"
ocd: 2026-07-10
lmd: 2026-09-05
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

^FD8NGOP2 [desc:"how AgentLens captures Claude Code lifecycle events: spy-agentlens.sh registered by --install-hooks on 11 events, POSTs to /api/hook-events, stored as NDJSON", keywords:"where_do_stopfailure_precompact_sessionstart_events_come_from what_is_spy_agentlens_sh install_hooks_registers_which_events hook_events_store_location how_does_agentlens_capture_lifecycle_events post_api_hook_events_endpoint hookEventStore_ndjson_retention query_hook_events_by_session which_lifecycle_events_are_hooked configchange_hook_event", ocd:2026-07-10, lmd:2026-09-05]
AgentLens captures Claude Code **lifecycle hook events** (TRDD-Q6ZOUVK5, commit c923f85):
`scripts/spy-agentlens.sh` (one fire-and-forget curl, always exit 0, no stdout) is registered
by `agentlenspro-cli --install-hooks` (bin renamed at the AgentlensPro fork; was `agentlens-cli`) on 11 lifecycle events — SessionStart/End, Stop,
StopFailure, Pre/PostCompact, PermissionRequest, Notification, SubagentStart/Stop, and
**ConfigChange** (TRDD-EYA3X5MQ — a `skills`-sourced ConfigChange is the candidate hook signal
for a `/reload-plugins`; `src/lifecycleEvents.ts` maps it, `isReloadConfigChange` tags it) — and POSTs
the raw payload to `POST /api/hook-events`. `src/hookEventStore.ts` persists them as
append-only NDJSON daily buckets in `~/.agentlens/hook-events/` (31d retention); query via
`GET /api/hook-events?session=&ev=&since=&until=&limit=`.

^XLG231OE [desc:"why hook events matter: they carry rate-limit deaths, compaction boundaries, and lifecycle signal that JSONL/OTEL bodies lack; planned burnMonitor and cache-break consumption", keywords:"why_are_hook_events_captured what_do_hook_events_carry_that_otel_lacks exact_rate_limit_turn_death_signal compaction_boundary_and_trigger_source burnmonitor_window_ceiling_plan cache_break_classifier_evidence_hook trdd_8enyleio_planned_consumption", ocd:2026-07-10, lmd:2026-09-05]
**Why:** these events carry signals the JSONL transcripts and raw OTEL bodies LACK — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle. Consumption into burnMonitor (measured window ceiling) and the cache-break
classifier (COMPACTION with `evidence: hook`) is planned in TRDD-8ENYLEIO.

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

^A5061IN6 [desc:"capture is optional: every future consumer of hook-event data must degrade to inference when the store is empty, and label which evidence it used", keywords:"hook_capture_is_optional degrade_to_inference_when_store_empty label_evidence_used_hook_vs_inference what_if_hook_events_store_is_empty", ocd:2026-07-10, lmd:2026-09-05]
**Why:** capture is optional — every future consumer must degrade to inference when the store
is empty and label which evidence it used.

^DJISEOQJ [desc:"how to install/change hook registration: only via --install-hooks (safeConfigEdit transaction); never hand-edit settings.json; needs a session restart to take effect", keywords:"how_to_install_hooks never_hand_edit_settings_json safeconfigedit_transaction_for_hooks hook_config_change_needs_session_restart removes_dead_claude_spyglass_entries preserves_other_tools_hooks", ocd:2026-07-10, lmd:2026-09-05]
**How to apply:** install/replace via `--install-hooks` ONLY (safeConfigEdit transaction;
preserves other tools' hooks; removes dead claude-spyglass entries); never hand-edit
settings.json. Hook config changes need a session restart.

^KUNASMP4 [desc:"pointer to the full Claude Code hook-event catalog (all ~30 events, payloads, matcher support, IO schema) on the USER-scope reference page claude-code-hook-types", keywords:"full_list_of_claude_code_hook_events hook_payload_schema_reference matcher_support_for_hooks no_plugin_reload_hook_detect_via_configchange claude_code_hook_types_page", ocd:2026-07-10, lmd:2026-09-05]
**See also** the general Claude Code hook-event catalog (all ~30 events, payloads, matcher
support, I/O schema, and the "no plugin-reload hook / detect via ConfigChange-or-inference"
fact): USER-scope reference `[[claude-code-hook-types]]`.

^J5THPZAY [desc:"how hook-events and transcript-scanned commands overlap: /clear hits both routes, but /reload-plugins /reload-skills /plugin /login reach NO hook and are visible only in the transcript", keywords:"hook_events_vs_transcript_command_detection_overlap does_clear_have_a_hook reload_plugins_not_hooked_only_in_transcript configchange_registered_for_cache_break_not_reload_detection cache_risk_command_detection_relationship prefix_breaking_commands_invisible_to_hooks", ocd:2026-07-10, lmd:2026-09-05]
**See also** `[[cache-risk-command-detection]]` — the OTHER capture path. Some events arrive by
BOTH routes (`/clear` is `SessionStart{source:clear}` here and a `<command-name>` transcript entry
there), but the prefix-breaking commands (`/reload-plugins`, `/reload-skills`, `/plugin`, `/login`)
reach NO hook at all and are visible only in the transcript. `ConfigChange` is registered by
`--install-hooks` because a mid-session config change is itself a real cache-break cause — NOT
because it detects a plugin reload; that hypothesis was measured and refuted 2026-07-21.

^AXAYLDST [desc:"pointer to image-resident-cost-guard: the PreToolUse burn-gate consumer that added Read (the first non-rare tool) to GATE_MATCHER, with its per-call cost bounded CLI-side", keywords:"why_is_read_in_gate_matcher image_resident_cost_guard_relationship pretooluse_consumer_of_burn_gate_read_tool bounded_per_call_cost_cli_side", ocd:2026-07-10, lmd:2026-09-05]
See also: [[image-resident-cost-guard]] (the PreToolUse consumer that put `Read` — the first
non-rare tool — into `GATE_MATCHER`, and how its per-call cost is bounded CLI-side).


^ATOM-FIS4-EY4J [desc: "The burn-gate's RUNAWAY_FANOUT rule (≥8 SubagentStarts machine-wide in 60s) never DENIES a fork (TRDD-3EZ6SJ2Z, in the working tree 2026-09-05, gates/commit/deploy pending — update this line when live", keywords: burn-gate_blocked_my_fork fork_denied_runaway_fan-out review_fork_refused_by_agentlens_gate 8_subagent_launches_in_the_last_60s RUNAWAY_FANOUT_fork stop_hook_review_fork_blocked why_is_the_gate_blocking_fork_agents fork_reuses_parent_context_no_cache_build machine-wide_launch_count fresh_agent_denied_fork_allowed AGENTLENS_GATE=off_fork agentGate.ts_runaway60s, type: project, trdd: TRDD-3EZ6SJ2Z, ocd: 2026-09-05, lmd: 2026-09-05]
**Status 2026-09-05 15:52: edited in the working tree, NOT committed; check-types and compile-tests green, mocha + cargo gates still running, alcore not rebuilt — a session recalling this before the STATUS line changes must treat the live gate as still type-blind.** `RUNAWAY_FANOUT` counts SubagentStart events MACHINE-WIDE (all sessions, all projects) over 60 s and denies at ≥8 (`runaway60s`, env `AGENTLENS_GATE_RUNAWAY_60S`). The deny was type-blind, so a stop-hook review FORK was refused whenever OTHER sessions' fresh spawns filled the window — the gate blocked its own mandated review (USER report, TRDD-3EZ6SJ2Z). Fix in both twins (`src/agentGate.ts` runaway branch, `rust-core/…/burn/agent_gate.rs`): `subagent_type == "fork"` (and not the keep-warm pinger) returns `decision: warn`, `code: RUNAWAY_FANOUT`, reason "This fork is allowed: it reads the caller's cache entry and writes no new prefix"; non-forks keep the deny. Basis: the TRDD-DIZ289UQ measurement already used for the THRASH rule (a fork's first request is a warm read, cache_creation 1–3k vs 380k–785k read). The fat-parent-into-COLD-cache fork case keeps its own two rules. The count still includes forks — only the DENY is fork-exempt. Live only after the Rust rebuild + codesign + `agentlenspro server restart` (alcore serves `/api/agent-gate`).


^ATOM-5WTK-6YPU [desc: "All agentlenspro hook timeouts doubled 2026-09-05 (USER order, TRDD-GXKRBK1Q; in the working tree, commit + setup re-apply pending — update when live): settings.json ceilings 10s lifecycle/gate/superv", keywords: hook_timeout hooks_often_hit_the_timeout doubled_hook_timeouts settings.json_timeout_10 review-gate_timeout_20 AGENTLENS_HOOK_TIMEOUT_default AGENTLENS_GATE_TIMEOUT_default gate_fails_open_under_load silently_dropped_capture_event hook_timed_out_warning_in_terminal hookInstall.ts_matcher_timeout relax_the_timeouts_of_all_hooks, type: project, trdd: TRDD-GXKRBK1Q, ocd: 2026-09-05, lmd: 2026-09-05]
**Status 2026-09-05 15:52: edited in the working tree, NOT committed and NOT yet applied to any settings.json — update this line when `agentlenspro setup --yes` has converged it.** The `timeout` each installer matcher writes into `~/.claude/settings.json` (`src/cli/hookInstall.ts`): lifecycle forwarder (async) 10 s, burn gate (sync) 10 s, review gate (sync, local disk only) 20 s, review supervisor 10 s — doubled from 5/5/10/5 (TRDD-GXKRBK1Q, USER: "relax the timeouts of all hooks.. they must be doubled"), after the 2026-08-14 raise (forwarder 2→5 s, gate 3→5 s) when the owner's machine measured load-avg 130+ and an 800 ms TCP connect starved. The hooks' OWN network budgets must sit inside those ceilings and doubled with them: `hookHandlers.ts` `AGENTLENS_HOOK_TIMEOUT` default 2 s (was 1), `AGENTLENS_GATE_TIMEOUT` default 4 s (was 2); `setup.ts` verify-exec env 4/4 (was 2/2). Why: every hit on the ceiling is a silently dropped capture event or a sync gate FAILING OPEN; the owner's machine measured load-avg 16–26 on 2026-09-05. New values reach a machine only through `agentlenspro setup --yes` / `--install-hooks` (safeConfigEdit). The installer identifies its own entries by COMMAND (`isOurHookCommand(h.command)`, `hookInstall.ts:216`), never by timeout, so old 5 s entries are stripped and rewritten while foreign hooks survive. Read back with a JSON parse of settings.json, never by eye.

## Notes and lessons learned
[^1]: [id:ATOM-BUCKET-NAME-NAN-AND-STOP-HOOK-EXIT, status:valid, keywords:"stop_hook_error_every_turn bucket_name_regex_matches_calendar_invalid_dates NaN_defeats_purge happy_path_must_exit_0_on_absent_optional_input", ocd:2026-07-10, lmd:2026-07-10] Two field lessons from shipping this. (a) The
  bucket-name regex \d{4}-\d{2}-\d{2} also matches calendar-invalid names ('2026-13-99' →
  NaN, '2026-02-31' overflows): NaN silently defeated BOTH the read fast-path and the
  string-compare purge — an unpurgeable file counted forever. Fixed with bucketDayMs()
  round-trip validation (a5b3519); parse dates once, validate by round-trip, compare
  numerically. (b) AgentLens's own pending-prompt Stop hook '[ -f "$f" ] && cat …' exited 1
  on every turn with no pending file → a "Stop hook error" banner every turn (a073e3d). A
  hook's happy path must be exit 0: absent-optional-input is the NORMAL case, not an error.
