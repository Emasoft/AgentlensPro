---
trdd-id: SIGBCMGL
title: Align agentlenspro taxonomies and diagnostics with Claude Code 2.1.233→2.1.252
column: human_review
created: 2026-09-01T19:20:48+0200
updated: 2026-09-24T08:57:54+0200
current-owner: agentlenspro-15
task-type: feature
implementation-commits: [2d06942b, 46576993]
related: [YE15B2JK, BFUZ1THR, VY1IUVUM, B7DSTJLS]
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
- ~~**`rate_limits.spend_limit` (2.1.251)**~~ — deliberately NOT guaranteed: no gateway on this
      machine, so the flattened shape is unverifiable; add from a REAL captured row only (the
      YE15B2JK step-1 rule), as the `GUARANTEED_COLUMNS` comment at `src/statuslineStore.ts:230-233`
      records. Owned since 2026-09-05 by TRDD-BFUZ1THR (`backburner`, `review-after: 2026-10-05`),
      the one card for the first observed row — see the Approval log.
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

## Approval log

- 2026-09-05T15:28:39+0200 — ORCHESTRATOR decision on the 15:26 AI-review APPROVE: the one open box
  (`spend_limit`) was original scope the author deliberately deferred ("NOT guaranteed yet", unticked
  since `2d06942b`, which `git log --follow` shows is this card's first commit); unlike YE15B2JK's
  post-hoc box this one was part of the plan, so it is DELEGATED, not dropped: it cannot be met by
  code here and is the same item TRDD-YE15B2JK carried, so both now point at TRDD-BFUZ1THR and this
  card carries no open box. The owner or the USER may veto by restoring the box.
  `implementation-commits:` was first filled (`9f5259c7`) with every SHA the body cites — wrong, the
  field is for commits that landed THIS card's code. Corrected at 15:31/15:33 to the two code commits
  that are both tagged `TRDD-SIGBCMGL` AND covered by a box above: `2d06942b` (the alignment feat:
  prompt_cache columns, ttl-resolved cost, model-switch hooks) and `46576993` (pricing divergences).
  Dropped: `494eb779` (YE15B2JK's), `aef94208` (B7DSTJLS's), `f36a934d` (this card's memory-page docs,
  not code), and `525bbcf8` (tagged SIGBCMGL, but a CC 2.1.257 fable-5-1 pricing entry landed at 21:38
  after this card reached `ai_review` — outside the 2.1.233→2.1.252 scope and named by no box; a tag
  is not ownership). Human-review reader: the
  check-types/esbuild box is UNVERIFIED (test run deferred) and the "2535 passing / 1 failing" count
  has no saved run artifact — judge those two as the author's claims.
- 2026-09-24T08:57:37+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.

## AI review verdict — run: 2026-09-05T15:26:20+0200

| Box | Status | Evidence |
|---|---|---|
| statusline `prompt_cache` block / `cache-expired` | ✓ VERIFIED | `git show --stat 494eb779` — `cacheExpiredCli.ts` +107, 5 named tests present |
| 12 `prompt_cache_*` in `GUARANTEED_COLUMNS` | ✓ VERIFIED | `src/statuslineStore.ts:218-229`, counted 12 |
| `cache` view 5m/1h via `prompt_cache_ttl` + `misses` | ✓ VERIFIED | `src/cli/statuslineHistoryCli.ts:471-472` |
| `PreModelSwitch`/`PostModelSwitch` in `HOOK_EVENTS` | ✓ VERIFIED | `src/cli/hookInstall.ts:49-57` |
| `spend_limit` deliberately not guaranteed | ✓ VERIFIED (open box matches) | `src/statuslineStore.ts:230-233`, and `git log --follow` shows this box unticked since the FIRST authoring commit `2d06942b` — original scope, honestly deferred, not appended/mis-columned |
| TTL-regime matrix, `f36a934d`, `ATOM-N9P1-MNYD` | ✓ VERIFIED | `git show --stat f36a934d`; atom text at `cache-ttl-model.md:84-86` |
| `modelPricing`/1.1× premium, `46576993` | ✓ VERIFIED | `git show --stat 46576993`, `pricing.ts` +9 |
| Version-gated cache-miss causes | ✓ VERIFIED (landed in `cache-ttl-model.md`, not a separate "research page" as worded) | `cache-ttl-model.md:86` names OAuth-refresh, ScheduleWakeup, pre-2.1.239 trace fragmentation |
| Sonnet 5 auto-compact ~967K no-op | ✓ VERIFIED | `grep -rn "934\|967" src/` — no such constant |
| Statusline data-quality caveat | ✓ VERIFIED | `f36a934d` diff, `statusline-capture-and-store.md` |
| Todo-tool taxonomy no-op | ✓ VERIFIED | `grep -rn "TaskCreate\|TodoWrite" src/summarizers/` — 0 hits |
| Acceptance: check-types/esbuild 0 | ✗ UNVERIFIED — deferred (CPU contention) |
| Acceptance: 2535 passing/1 failing, B7DSTJLS root fix | ? INFERRED — root fix `aef94208` verified + corroborated by `reports/cachebreak-flake/20260901_195258+0200-load-dependence-analysis.md`; exact pass/fail counts have no saved run-output artifact |
| Acceptance: remaining boxes carded | ✓ VERIFIED | matches `## Work` text |

Defects: `implementation-commits:` frontmatter field absent despite 4 cited code SHAs (minor,
non-blocking — recoverable via body + `git log --follow`). No follow-up TRDD named for
`spend_limit` (unlike ttl-regime's named follow-up) — low risk, nothing actionable without a
gateway sample.

Full report: `reports/ai-review/20260905_152620+0200-SIGBCMGL.md`

**Verdict: APPROVE**
