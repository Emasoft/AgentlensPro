---
trdd-id: ILUPCXRE
title: Align AgentlensPro to recent Claude Code changes
column: backburner
status: tasked
created: 2026-09-27T20:11:43+0200
updated: 2026-09-27T20:12:36+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-27T20:11:43+0200
---

# Align AgentlensPro to recent Claude Code changes

CONTEXT: Three read-only changelog slices over the full 2.1.x history (snapshot docs_dev/cc-changelog-snapshot-2026-09-27.md) produced ranked top-signal lists of changes affecting AgentlensPro integration surfaces (OTEL ingestion, hooks, statusline payload, settings precedence, pricing, cache economics). This card turns those signals into dispatched adaptation work. Evidence: reports/cc-alignment/20260927_163748+0200-changelog-slice-A-283-277.md (2.1.283-277), reports/cc-alignment/20260927_163913+0200-changelog-slice-B-276-241.md (2.1.276-241), reports/cc-alignment/20260927_165924+0200-changelog-slice-C-240-older.md (2.1.240 and older).

## Approval log

- 2026-09-27T20:11:43+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Work items (from the three slices)

1. pricing.ts (2.1.280): add claude-opus-5-5 row (1M context, USD 4/20 per Mtok, 0.20 cache reads; new default Opus, Pro/Team default flipped Sonnet to Opus) and Fable 5.1 row (2.1.257: USD 10/50 per Mtok, 0.25 cache reads); bump PRICING_LAST_UPDATED in src/shared/pricing.ts. 2. TTL-regime (2.1.243 promptCacheTtl/subagentPromptCacheTtl; 2.1.248 experimental.cacheTtl per-agent frontmatter): main=1h/subagent=5m is now an overridable default, not a law — cache-ttl-model and the TTL matrices need a config-driven branch before trusting any TTL prediction. 3. --install-otel vs 2.1.282: project and local settings now IGNORE OTEL env vars (CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_LOG_*, endpoint setters) — verify the installer writes user scope only; consider a setup check flagging OTEL vars in project settings (2.1.282 added a startup notice/doctor entry CC-side). 4. cacheBreak.ts cause reconciliation: multiple cache-break classes fixed upstream (2.1.277 post-/clear SessionStart-hook-output miss; 2.1.280 host-app model-switch miss and resumed fork-subagent tool-list rebuild; 2.1.281 resume-shape and MCP-disconnect-while-connecting fixes) and /cost now names thinking-mode causes (2.1.280) — reconcile the cause inventory against what is still real. 5. Statusline payload growth (2.1.251 prompt_cache object with hit ratio/misses/re-cached/warm-cold plus rate_limits.spend_limit; 2.1.260 likely miss-cause inside prompt_cache): parse the new fields in statusline-history — they carry harness-reported cache state currently inferred from spans. 6. OTEL schema: hook_execution_complete gains output sizes and oversized-output counts (2.1.280); effort attr on claude_code.llm_request (2.1.274); new claude_code.managed_settings_resolved event (2.1.274); assistant_response event (2.1.193 — upgrade hazard: unset OTEL_LOG_ASSISTANT_RESPONSES follows OTEL_LOG_USER_PROMPTS); request-to-transcript-message linking via OTEL_LOG_RAW_API_BODIES index.jsonl + request_body_id/message.id (2.1.274) — the ctxvis nothing-on-disk-links-them premise is version-dependent from 2.1.274 on. 7. TaskOutput tool removed (2.1.277; taskOutputMaxChars/TASK_MAX_OUTPUT_LENGTH dead): sweep shipped skills/agents/docs for TaskOutput references and either setting name. 8. Hook surface: PreModelSwitch/PostModelSwitch events (2.1.251) and SessionStart resume payload gains staleness + estimated re-cache cost; megabyte hook output can wedge the session (2.1.247); invalid-JSON stdout is now a hook error (2.1.248); burn-gate deny patterns must not rely on unbounded repeated blocking (stop-hook block cap, 2.1.143 CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). 9. Subagent-results framing change (2.1.277: marked header + indented result, anti-injection): spawnRollup/subagent analytics parsers must handle the new shape. 10. 2.1.240 hook-live-reload memory claim: NO changelog support in this snapshot (slice C: 2.1.240 is a no-op release for hooks) — the memory note hook-registration-live-reload-2-1-240 is empirically-derived only; verify empirically or annotate it.

## Non-goals

No MCP server registration (repo doctrine: the MCP server is deliberately not registered). No publish in this card — publishing is tag-driven and out of scope.

## Acceptance

Each work item lands as its own dispatched task with the changed surface verified: pricing rows present and PRICING_LAST_UPDATED bumped; TTL config branch tested; installer scope verified; cause list reconciled; statusline fields parsed; OTEL ingest tolerant of new events/attrs; TaskOutput sweep clean; hook registry and output hygiene updated; parsers handle the new subagent framing; the 2.1.240 memory claim verified or annotated. The card does not close until every item is either landed or split to its own TRDD.
