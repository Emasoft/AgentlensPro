---
trdd-id: SIGBCMGL
title: Align agentlenspro taxonomies and diagnostics with Claude Code 2.1.233→2.1.252
column: ai_review
created: 2026-09-01T19:20:48+0200
updated: 2026-09-01T20:00:30+0200
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
- [x] **TTL-regime matrix update (TRDD-VY1IUVUM consumer)** — 2.1.243/248 broke "fresh subagents
      are ALWAYS 5m" open: `promptCacheTtl` + `subagentPromptCacheTtl` settings (API-key/cloud
      users) and per-agent `experimental.cacheTtl` frontmatter now set the tier explicitly. The
      statusline `prompt_cache_ttl` column is the per-session ground truth and should be preferred
      over regime inference wherever a session has samples. DONE: `cache-ttl-model` memory page
      atom (ATOM-N9P1-MNYD, `f36a934d`). REMAINING (own follow-up): the server-side ttl-regime
      resolution code does not yet consult `prompt_cache_ttl` — a Rust change in alcore.
- [x] **`modelPricing` managed setting (2.1.243) + 1.1× data-residency premium (2.1.239)** —
      documented in `pricing.ts` (`46576993`): both are sanctioned harness-vs-list divergences;
      diagnostics comparing the two must label a systematic org-wide offset as contracted/premium
      rates, never a pricing-table bug. No rate substitution implemented (neither applies to this
      machine; doctrine already prefers harness `cost_usd`).
- [x] **Version-gated cache-miss causes** (docs only, per the TRDD-B9ERTBZ9 bar — name a cause
      only when distinguishable): pre-2.1.248 hourly OAuth-refresh tool-def re-render; ScheduleWakeup
      def change on overage resume (fixed 2.1.248); OTEL trace fragmentation from PreToolUse-deferred
      tools (fixed 2.1.239 — affects span-store session stitching for older captures). Record in
      the cache-invalidation research page.
- [x] **Sonnet 5 auto-compact at ~967K on the 1M window (2.1.247)** — verified no-op: grep found
      no 934K/967K constant anywhere in `src/`; nothing keys on the old figure.
- [x] **Statusline data-quality caveat**: pre-2.1.243 samples can carry a stale pre-reset
      `rate_limits` percentage after an idle window reset (fixed since). Note on the
      statusline-capture-and-store memory page for anyone querying historical windows.
- [x] **Todo-tool taxonomy (2.1.233)**: verified no-op — grep found zero TaskCreate/TodoWrite
      references in `src/summarizers/`; no absence-as-signal assumption exists.

## Acceptance

- [x] check-types 0, esbuild 0, cache view + cache-expired live-verified against real samples.
- [x] Full suite after the batch: **2535 passing / 1 failing** — the 1 red was the pre-existing
      B7DSTJLS real-corpus timeout, whose root fix (`aef94208`) landed mid-run un-compiled; the
      file standalone after recompile is **67/67, exit 0**. No red traces to this card's changes.
- [x] Remaining boxes carded: spend_limit stays open here (needs a gateway sample); the server-side
      ttl-regime consult of `prompt_cache_ttl` is DEFERRED with rationale — the CLI already answers
      authoritatively from disk, so a server duplicate adds little; revisit only if a server-side
      consumer (dashboard, MCP tool) needs the verdict without the CLI.
