---
trdd-id: B9ERTBZ9
title: Model the documented cache-break causes the classifier lacks
column: completed
created: 2026-08-04T21:43:34+0200
updated: 2026-08-18T12:45:00+0200
current-owner: session
task-type: feature
relevant-rules: []
npt: []
eht: []
implementation-commits: [05497e8]
---

# Model the documented cache-break causes the classifier lacks

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-04T22:47+0200

**TIER 1 IS IMPLEMENTED, TESTED AND COMMITTED (`05497e8`).** Every acceptance box below is ticked.
Whole unit suite green (2,035 passing); `check-types`, `lint`, `check-identities`, `check-mirrors`,
`check-guards` all pass. Version bumped to 2.23.0 with a CHANGELOG entry; `CLAUDE.md` §4 and the
`agentlenspro-diagnostics` skill carry the new facts.

**NEXT ACTION:** deploy on this machine (`pnpm run deploy:safe`), then human review. NOT published —
publishing is tag-driven and is the owner's call.

### What the real corpus says about the new causes — read this before judging the work

On the last 24 h of captured bodies (115 classified events, 6.95 M cache_creation tokens) **none of
the new causes fired**, and `UNCLASSIFIED` is unchanged at 32.4% (39 events, 2.25 M tokens). That is
the expected result, not a defect: every TIER 1 cause is *rare by construction* (a cwd/git snapshot
differs only across streams; an effort change needs two explicit values in consecutive turns of one
session; the no-cache pair needs a joinable response for one of the 4 marker-less requests on this
machine). They are modelled so that when one DOES happen it is named instead of silently pooled.

**The residual UNCLASSIFIED is a DIFFERENT gap, and it is now the biggest one.** Its dominant real
shape is `usertext block changed at pos 46: msg[0] user` — a SEGMENT of the giant injected first user
message changed, and `classifyContentKind` has no kind for it, so it falls to `usertext` →
`UNCLASSIFIED`. That is segment-level content classification, not a missing documented cause; it is
out of this TRDD's scope and is filed as its own card.

### Design decisions a later reader must not undo

- **Absent ≠ any explicit value.** `THINKING_CONFIG_CHANGED` / `EFFORT_PARAM_CHANGED` /
  `TOOL_CHOICE_CHANGED` fire ONLY between two different EXPLICIT values. "Setting a parameter
  explicitly to its default is equivalent to omitting it" and the per-model defaults are unpublished,
  so absent→explicit is undecidable from a captured body. Do not "improve" this into a guess.
- **`EFFORT_SWITCH` now means `speed`/fast mode only** — the old blended thinking+speed+tool_choice
  signature is gone.
- **An unknown model gets NO `BELOW_MIN_CACHEABLE` verdict.** The minimum spread is 8×; a borrowed
  threshold would be wrong for most models.
- **`LOOKBACK_OVERFLOW` requires `cache_read === 0`.** That is what separates it from `NORMAL_GROWTH`,
  which finds its entry and reads it. Its distance is counted in MESSAGES (conservative).
- **The env/git regions are checked BEFORE the block diff, but only when the NORMALIZED region also
  differs** — otherwise a moving clock inside them would steal `SYSTEM_TIMESTAMP`.
- **The prompt-size accumulator must not materialize message text.** The naive version (build the
  string, then measure it) slowed the bounded scan enough to time out the real-corpus test.

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

- [x] Each TIER 1 cause has a detector reading ONLY data already captured — no new capture surface.
      (`output_config`, the `<env>`/`# Environment` and `gitStatus:` regions, and the cache_control
      marker count all come out of the request body the scan already parses.)
- [x] `EFFORT_PARAM_CHANGED` does NOT fire when effort is set explicitly to the model's default
      (documented no-op). Pinned by a test — this is the one that will produce false positives.
      Solved WITHOUT a defaults table (there is none published): fire only between two different
      EXPLICIT values, because two explicit values cannot both be the default.
- [x] `BELOW_MIN_CACHEABLE` reads the per-model minimum from a table, not a single constant: the
      spread is 8× (512 → 4,096) and a threshold keyed on one model id is wrong for the rest.
      An unknown model returns `undefined` → no verdict, never a borrowed number. Pinned by a test
      that runs the SAME prompt against Opus 5 and Haiku 4.5 and gets opposite answers.
- [x] `LOOKBACK_OVERFLOW` replaces `UNCLASSIFIED`/`UNATTRIBUTABLE` only when the ≥20-block condition
      actually holds; otherwise the honest unnamed verdict stands. Pinned at 24 (fires) and 19 (does
      not — `COLD_START` stands).
- [x] Every new cause carries a remediation string stating its CONDITION, not an absolute — the
      lesson from `c6802f0` (reload/MCP text asserted an unconditional reset the docs contradict).
      Pinned by a test asserting each new remediation names a condition.
- [x] Tests built from REAL captured bodies. Both method errors that produced TRDD-V8YOWHVT
      (cross-stream diffing, breakpoint-blind diffing) were invisible to synthetic fixtures.
      Fixtures reproduce shapes measured across the 1,377-request live spool (values anonymized so
      `check-identities` stays green), PLUS a real-corpus test that drives both region extractors over
      the actual captured bodies — a regex matching nothing would otherwise keep every other test green.
- [x] `CLAUDE.md` §4 and the `agentlenspro-diagnostics` skill updated; CHANGELOG entry; version bump
      (2.23.0). The skill's stale "not corroborated" image claim was corrected to the measured result
      in the same pass, and its enum COUNT in prose removed.
- [x] No count of enum values written into prose anywhere — that error propagated to 4 files today.

## Evidence

`reports/cache-invalidation-research/` (7 reports) · TRDD-V8YOWHVT · `ATOM-0CUW-IVP6`.

## Approval log

- 2026-08-14T02:30:00+0200 — COMPLETED (human_review → complete). Reviewed under the owner's
  standing delegation ("review them yourself... based on verified facts"): every load-bearing claim
  verified first-hand against current code with file:line evidence — see
  reports/trdd-review/20260814_015415+0200-batch2-review.md (this card's section). No contradiction
  found; open residuals, where any, are recorded in that report and are non-blocking.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/cacheBreakTimeline.ts defines WORKING_DIR_CHANGED (TIER 1 causes present).
