---
trdd-id: B9ERTBZ9
title: Model the documented cache-break causes the classifier lacks
column: dev
created: 2026-08-04T21:43:34+0200
updated: 2026-08-04T21:43:34+0200
current-owner: session
task-type: feature
relevant-rules: []
npt: []
eht: []
---

# Model the documented cache-break causes the classifier lacks

## ⏵ STATE — READ THIS FIRST ON RESUME

Unblocked by TRDD-V8YOWHVT (attribution soundness settled; raw-body path verified breakpoint-aware).
Sourced from 7 doc reports in `reports/cache-invalidation-research/` (15 doc pages, 2026-08-04).

**NEXT ACTION:** implement TIER 1 below in `src/cacheBreakTimeline.ts`, TDD, one cause at a time.

## The rule that scopes this

**A cause is only worth adding if it is DETECTABLE from data we already capture.** The raw request
bodies (`extractTurnPrefix`) carry model, system[], tools[], messages[], and request params. The
composition path (`ContextSource[]`) carries neither positions nor params, so **nothing here belongs
there** — that was settled in TRDD-V8YOWHVT.

Adding an undetectable cause produces an enum value nothing can ever emit, which is worse than the
gap: it implies coverage that does not exist.

## TIER 1 — documented, detectable, and relevant to THIS machine

| cause | detect by | doc basis |
|---|---|---|
| `WORKING_DIR_CHANGED` | the env block in `system[]` (cwd/platform/shell/OS) differs | "the cache is effectively scoped to one machine and directory … that includes worktrees of the same repository" |
| `GIT_STATE_CHANGED` | the git block (branch + recent commits) at the tail of `system[]` differs | "sequential sessions share the prefix only when the git status snapshot at startup matches" |
| `LOOKBACK_OVERFLOW` | no changed block AND ≥20 blocks added since the last write | "the lookback window is 20 blocks … if a growing conversation pushes your breakpoint 20 or more blocks past the last write, the lookback misses it" |
| `BELOW_MIN_CACHEABLE` | prompt < the model's documented minimum AND both usage counters 0 | 512 (Opus 5 / Fable 5 / Mythos 5) · 1,024 (Opus 4.8, Sonnet 5/4.6/4.5) · 2,048 (Opus 4.7, Haiku 3.5) · 4,096 (Opus 4.6/4.5, Haiku 4.5) — **silent, no error** |
| `THINKING_CONFIG_CHANGED` | `body.thinking` differs between turns | "the thinking configuration … is rendered into the prompt, so changing it always invalidates message blocks" |
| `EFFORT_PARAM_CHANGED` | `body.output_config.effort` differs | same row; **explicitly setting the model default is a NO-OP — must not fire** |
| `TOOL_CHOICE_CHANGED` | `body.tool_choice` differs | "changes to `tool_choice` only affect message blocks" |
| `CACHING_DISABLED` | zero `cache_control` markers anywhere in the request | `DISABLE_PROMPT_CACHING{,_HAIKU,_SONNET,_OPUS,_FABLE}` |

## TIER 2 — documented but NOT detectable here; do NOT add enum values

Record as doc knowledge only (they live in `CLAUDE.md` §4 already): `opusplan` plan-mode toggle and
automatic safety-classifier fallback (both surface as `MODEL_SWITCH`, already covered); citations /
web-search / speed toggles (not used by Claude Code); workspace + organization cache isolation;
unstable `tool_use` JSON key ordering (Swift/Go only); concurrent-requests-before-first-response;
gateway rejecting a breakpoint. **Adding these would be unemittable enum values.**

## Acceptance criteria

- [ ] Each TIER 1 cause has a detector reading ONLY data already captured — no new capture surface.
- [ ] `EFFORT_PARAM_CHANGED` does NOT fire when effort is set explicitly to the model's default
      (documented no-op). Pinned by a test — this is the one that will produce false positives.
- [ ] `BELOW_MIN_CACHEABLE` reads the per-model minimum from a table, not a single constant: the
      spread is 8× (512 → 4,096) and a threshold keyed on one model id is wrong for the rest.
- [ ] `LOOKBACK_OVERFLOW` replaces `UNCLASSIFIED`/`UNATTRIBUTABLE` only when the ≥20-block condition
      actually holds; otherwise the honest unnamed verdict stands.
- [ ] Every new cause carries a remediation string stating its CONDITION, not an absolute — the
      lesson from `c6802f0` (reload/MCP text asserted an unconditional reset the docs contradict).
- [ ] Tests built from REAL captured bodies. Both method errors that produced TRDD-V8YOWHVT
      (cross-stream diffing, breakpoint-blind diffing) were invisible to synthetic fixtures.
- [ ] `CLAUDE.md` §4 and the `agentlenspro-diagnostics` skill updated; CHANGELOG entry; version bump.
- [ ] No count of enum values written into prose anywhere — that error propagated to 4 files today.

## Evidence

`reports/cache-invalidation-research/` (7 reports) · TRDD-V8YOWHVT · `ATOM-0CUW-IVP6`.
