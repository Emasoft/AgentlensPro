---
trdd-id: SIGBCMGL
title: Align agentlenspro taxonomies and diagnostics with Claude Code 2.1.233→2.1.252
column: dev
created: 2026-09-01T19:20:48+0200
updated: 2026-09-01T19:20:48+0200
current-owner: agentlenspro-15
task-type: feature
---

# Align agentlenspro with the CC 2.1.233→2.1.252 changelog

USER directive 2026-09-01: read the changelog carefully, track the new taxonomies in the server
dashboard + CLI diagnostics, and take advantage of the new information. The previous alignment
pass covered through 2.1.232 (`reports/cc-alignment/20260814_125212+0200-cc-2.1.217-232-gap-analysis.md`).

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-01

Done this session (commits named below); remaining boxes are docs/design work, none blocking.

## Work

- [x] **statusline `prompt_cache` block (2.1.251/252)** — the harness's own cache verdict.
      `cache-expired` now answers AUTHORITATIVELY from `prompt_cache_expires_at` off disk
      (`494eb779`, TRDD-YE15B2JK); all 12 flattened `prompt_cache_*` columns added to
      `GUARANTEED_COLUMNS` (trap-5 protection); the `cache` view resolves its 5m/1h cost bracket
      to ONE figure via `prompt_cache_ttl` and shows the harness `misses` counter beside the
      computed verdict. Field names verified against a LIVE row, not the docs.
- [x] **`PreModelSwitch`/`PostModelSwitch` hook events (2.1.251)** — added to `HOOK_EVENTS`.
      Captures the AUTOMATIC switches (safety-classifier fallback, opusplan toggles) that
      invalidate the prompt cache with no transcript trace. Pipeline is name-agnostic end to end
      (verified: `build_hook_event_record` takes `hook_event_name` verbatim), so registration is
      the whole change. Takes effect after `agentlenspro setup`/`--install-hooks` + session restart.
- [ ] **`rate_limits.spend_limit` (2.1.251)** — deliberately NOT guaranteed yet: no gateway on
      this machine, so the flattened shape is unverifiable. Add from a REAL captured row only
      (the YE15B2JK step-1 rule). A comment in `GUARANTEED_COLUMNS` records this.
- [ ] **TTL-regime matrix update (TRDD-VY1IUVUM consumer)** — 2.1.243/248 broke "fresh subagents
      are ALWAYS 5m" open: `promptCacheTtl` + `subagentPromptCacheTtl` settings (API-key/cloud
      users) and per-agent `experimental.cacheTtl` frontmatter now set the tier explicitly. The
      statusline `prompt_cache_ttl` column is the per-session ground truth and should be preferred
      over regime inference wherever a session has samples. Update `cache-ttl-model` memory page +
      the ttl-regime resolution code to consult it.
- [ ] **`modelPricing` managed setting (2.1.243) + 1.1× data-residency premium (2.1.239)** —
      two documented ways harness `cost_usd` legitimately diverges from `pricing.ts` list-price
      computation. Doctrine already prefers harness `cost_usd`; add a note in `pricing.ts` and
      make cost-comparison diagnostics label a systematic ~10% or org-discount offset as
      "contracted/premium rates" instead of flagging it as an anomaly.
- [ ] **Version-gated cache-miss causes** (docs only, per the TRDD-B9ERTBZ9 bar — name a cause
      only when distinguishable): pre-2.1.248 hourly OAuth-refresh tool-def re-render; ScheduleWakeup
      def change on overage resume (fixed 2.1.248); OTEL trace fragmentation from PreToolUse-deferred
      tools (fixed 2.1.239 — affects span-store session stitching for older captures). Record in
      the cache-invalidation research page.
- [ ] **Sonnet 5 auto-compact at ~967K on the 1M window (2.1.247)** — update context-threshold
      constants/memory if any code keys on the old ~934K figure.
- [ ] **Statusline data-quality caveat**: pre-2.1.243 samples can carry a stale pre-reset
      `rate_limits` percentage after an idle window reset (fixed since). Note on the
      statusline-capture-and-store memory page for anyone querying historical windows.
- [ ] **Todo-tool taxonomy (2.1.233)**: TaskCreate/TodoWrite absent by default on Opus 4.8+/Sonnet 5/
      Fable 5 — check summarizers' tool-count expectations don't treat their absence as signal.

## Acceptance

- [x] check-types 0, esbuild 0, cache view + cache-expired live-verified against real samples.
- [ ] Full suite green after the batch (run with the next full-suite gate, not per-edit).
- [ ] Remaining boxes done or split into their own cards.
