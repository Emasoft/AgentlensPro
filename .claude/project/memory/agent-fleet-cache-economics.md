---
name: agent-fleet-cache-economics
description: "a wave of subagents burned way more than expected / do parallel agents share the prompt cache / concurrent identical spawns all paid the full cold write / should skills be inlined in the agent body or loaded with the Skill tool / cheapest way to run a skill pipeline over hundreds of items / workflow fan-out cost model"
ocd: 2026-07-24
lmd: 2026-07-24
metadata:
  node_type: memory
  type: project
  tier: component
---

# Agent-fleet cache economics — measured (2026-07-24, this repo's transcripts as instruments)

Two controlled experiments run via the Workflow tool, measured by reading each spawned agent's
`message.usage` from its transcript (the same extraction burn_seismic uses). Load-bearing results:

- **Fresh-agent boot tax:** a default workflow subagent boots with a ~186k-token prefix
  (system + CLAUDE.md + rules + tool surface) paid as a cold cache WRITE (1.25×) — even for a
  one-word task. Lean agent types shrink the base itself, which is the bigger lever because the
  base is re-read (0.1×) on EVERY request of EVERY worker.
- **Concurrent identical spawns RACE the cache:** 3 byte-identical agents launched within ~1 s
  EACH paid the full 186k cold write (cache_read 0) — the cache entry only exists once the first
  request *completes*. A 4th identical agent launched 5 s AFTER the wave COMPLETED hit 100%:
  cache_creation 0, cache_read 186,076 → a **12.5× cheaper boot**. Consequence: **AWAIT one
  warm completion first, then fan out** — never open with a `parallel()` wave of twins. The
  primer need only be a TRIVIAL same-prefix warm request (final lines "warm-up, do nothing"),
  so no real item is serialized; a fixed launch stagger is NOT equivalent — it races the first
  request's time-to-first-response (10–60s+, variable), and Workflow scripts have no
  sleep/timer anyway (an awaited `agent()` completion is the only wait primitive).
- **Inline vs Skill-tool loading (A/B, 6 agents, mock 4-skill pipeline with a forced retry):**
  warm steady-state ≈ 699k (inline) vs ≈ 795k (lazy) weighted/agent → **inlining always-used
  skills is ~12% cheaper** and makes the request count deterministic (17 vs 20–30). But the
  effect is second-order: the **first-order law is cost ∝ request count × 0.1×(base+context)**
  — one wandering worker's 10 extra requests cost more than all four skill loads combined, and
  one tight lazy worker beat the warm inline workers. Prompt discipline ("one Bash per stage,
  never print file bodies, batch independent calls") outranks the loading strategy.
- **Prefix-sharing preconditions:** org-scoped cache keys on the byte-exact prefix — workers
  share up to the first differing byte. So: identical skill SET and ORDER in agent definitions,
  fixed-first prompt layout with per-item variables as the LAST lines, deterministic stage
  sequence.

**How to apply:** the whole recipe is operationalized as the user-scope `/cheap-flow` command
(`~/.claude/commands/cheap-flow.md`): skills resolved once and inlined, `-verify` gates with
bounded retries, lean worker + cheap model, prime-then-pipeline, schema outputs, paths not
content. For fan-outs that need the PARENT's context, fork (inherits + renews the parent's
cache) instead of fresh spawns.

See also: [[image-resident-cost-guard]] (the delegate-to-a-subagent remedy for image reads —
priced by these same fleet economics), [[cache-ttl-model]] (the TTL regimes behind the 5-min subagent window),
[[agentlens-burn-token-model]] (the cost/weight doctrine), [[burn-seismic-statistical-model]]
(FANOUT_RATE — the detector that catches fleets violating these rules),
[[workflow-fleet-launch-economics]] (USER scope — the portable launch rules these
measurements produced, incl. the Workflow-sandbox constraints and the account-wide 429
hazard), [[read-once-edit-batched]] (USER scope — the file-touching half: merged
read-find-fix workers, staleness signals, zero-LLM discovery).

## Notes and lessons learned

[^1]: [id:ATOM-WAVE-RACE, status:valid, keywords:"parallel_wave_cold_write cache_race identical_agents_no_sharing prime_then_pipeline fan_out_boot_tax launch_stagger_races_ttft warm_request_prime", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT open with a parallel wave of identical agents OR a fixed launch stagger ("5s apart"),
  BECAUSE the cache entry exists only after the first request COMPLETES and time-to-first-response
  varies 10–60s+ — simultaneous twins 3/3 paid the full 186k write, and a stagger just races TTFT.
  DO AWAIT one trivial same-prefix warm request, then fan out (boot after completion: 100% hit,
  12.5× cheaper).

[^1a]: [id:ATOM-STAG-AMBG, status:valid, keywords:"stagger_after_launch_vs_completion ambiguous_measurement_phrasing 5s_stagger_misread", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT record a timing measurement as "N s after the wave" without naming the anchor,
  BECAUSE this page's original "5s stagger → 100% hit" (anchor: wave COMPLETION) was read as
  "5s after LAUNCH suffices" and nearly shipped a racing design. DO anchor every latency claim
  to its event (launch vs first-response completion) when writing it down.

[^2]: [id:ATOM-REQC-1ST, status:valid, keywords:"request_count_dominates skill_loading_second_order inline_vs_skill_tool wandering_agent_cost tool_call_boundary", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT optimize skill-loading strategy before request-count discipline, BECAUSE each request
  boundary re-reads the whole prefix at 0.1× — measured, 10 wandering requests cost more than
  all four skill loads, while inlining saved only ~12%. DO write worker prompts that mandate
  one tool call per stage, batched independent calls, and no file bodies in context.

[^3]: [id:ATOM-SKIL-DUPE, status:valid, keywords:"skill_reinvoke_duplicate context_append_only reload_skill_second_copy", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT re-invoke an already-loaded skill (or re-Read a loaded reference) to "refresh" it,
  BECAUSE the transcript is append-only — a second invocation appends a full second copy that
  rides forward at 0.1× every later turn. DO recall the copy already in context; the body
  loaded at turn N is present verbatim in every subsequent turn until /clear or /compact.
