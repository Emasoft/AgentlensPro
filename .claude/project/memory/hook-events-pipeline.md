---
name: hook-events-pipeline
description: "how does AgentLens capture Claude Code lifecycle events / where do StopFailure PreCompact SessionStart events come from / what is spy-agentlens.sh / hook-events store, --install-hooks, why not PreToolUse / Stop hook error every turn / which timeout does setup write into settings.json, hook timeout 30 s, review-gate timeout / review gate demands a review for an old command / review hook reads 4MB transcript tail / review gate re-arms every turn / review fork in a worktree credited / goal paused, hook blocked the turn 9 times / stop_hook_active ignored / transcript origin kind human / isMeta hook feedback looks like a new turn / heartbeat cron prompt is a user record with turnPosition / Cannot create agent worktree not in a git repository / review fork launched in a worktree / does the review fork need isolation"
ocd: 2026-07-10
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: hub
  globs: ["src/hookEventStore.ts", "src/lifecycleEvents.ts", "src/cli/hookInstall.ts", "src/cli/reviewGate.ts", "src/cli/reviewSupervisor.ts", "src/cli/delegateGate.ts"]
publish-globally: false
---

# Claude Code hook pipeline — overview

AgentLens hooks Claude Code lifecycle events and runs two gates on them. This page is the overview (what is captured, what is deliberately not hooked, where the full hook catalog lives); the detail lives in the component pages listed under Applies to.

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

^A5061IN6 [desc:"capture is optional: every future consumer of hook-event data must degrade to inference when the store is empty, and label which evidence it used", keywords:"hook_capture_is_optional degrade_to_inference_when_store_empty label_evidence_used_hook_vs_inference what_if_hook_events_store_is_empty", ocd:2026-07-10, lmd:2026-09-05]
**Why:** capture is optional — every future consumer must degrade to inference when the store
is empty and label which evidence it used.

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

## Applies to

- [[hook-burn-gate]] — the burn gate: the one PreToolUse/PostToolUse hook (Task/Agent/Workflow matcher), its four denied disaster launches, and the RUNAWAY_FANOUT fork exception.
- [[hook-install-and-timeouts]] — how hooks are installed (only through --install-hooks) and which timeouts setup writes into settings.json.
- [[review-gate-per-turn-scan]] — the Stop review gate's per-turn scan: it reads only the current turn, back to readCurrentTurn's start; the 4 MB tail remains only for delegateGate (TRDD-QQ2XIIZ6).
- [[review-gate-credit-and-isolation]] — which forks the review gate credits (REVIEW and MEASURE predicates) and why a review fork must spawn with no isolation parameter.
- [[review-gate-stop-hook-cap]] — why runMainGate ignores stop_hook_active, the open question of whether Claude Code's 9-block cap is per hook, and the 2026-10-14 goal pause attribution (TRDD-LR4SI79M).
- [[claude-code-transcript-turn-shapes]] — the transcript record shapes the review gate's turn-boundary logic depends on (what starts a turn, what only looks like one).

## Notes and lessons learned
