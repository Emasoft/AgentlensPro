---
trdd-id: V8YOWHVT
title: cacheBreak.ts attributes cache breaks with no model of cache_control breakpoints
column: todo
created: 2026-08-04T15:14:17+0200
updated: 2026-08-04T15:14:17+0200
current-owner: unassigned
task-type: bugfix
relevant-rules: []
---

# cacheBreak.ts attributes cache breaks with no model of `cache_control` breakpoints

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-04 15:4x

**The body below OVERSTATES the defect. Corrected after reading the code rather than inferring it.**

- `src/cacheBreakTimeline.ts` (the RAW-BODY path, behind `get_cache_break_timeline`) **already models
  the message-level breakpoint**: `extractTurnPrefix` diffs the tools array + the system array + the
  message blocks *"up to and including the LAST message-level `cache_control` breakpoint (everything
  after that is the volatile current-turn tail … excluded from the break diff)"*. So the
  `HOOK_INJECTION` verdict that triggered this card is **better founded than I claimed**, and the
  blanket statement "our classifier has no breakpoint model" was wrong.
- `src/shared/cacheBreak.ts` (the COMPOSITION path, behind the webview Cache tab and
  `CacheBreakCause`) has **no** breakpoint model and structurally cannot acquire one: its input is
  `ContextSource[]`, which carries neither block positions nor `cache_control`. This half of the
  defect stands in full.
- **Still open, and now the sharpest question:** `extractTurnPrefix` includes the **whole system
  array**, ignoring the system-level breakpoints measured at `system[2]`/`system[3]`. `system[0]`
  (the billing header) changes on EVERY request, so any turn it classifies has a guaranteed
  system-tier divergence. Whether that produces false attribution depends on how `segmentInjected`
  splits that text — **NOT YET VERIFIED. Do not assume either way.**

**DONE (commit `14c8c62`, 2020 tests passing):** `cacheBreak.ts` no longer claims a culprit it cannot
justify. Every set-diff attribution carries `attribution: 'block-diff-only'` + `confidence: 'low'`,
and a write that DOMINATES its turn with nothing to blame is now `UNATTRIBUTABLE` (`broke: true`,
real `wastedTokens`) instead of the old silent `broke: false` / `wastedTokens: 0`, which hid the
costliest event the analyzer exists to surface. A modest write with no divergence still stays
silent — both directions are pinned by tests so this cannot become a false-positive generator.

**NEXT ACTION — one step, runnable as written:** verify the `system[0]` question before touching
`cacheBreakTimeline.ts`. `extractTurnPrefix` feeds the WHOLE `system[]` array into the diff, but the
real breakpoints sit at `system[2]`/`system[3]`, and `system[0]` (the billing header) changes on
every request. Determine whether `segmentInjected()` emits that volatile text as a diffable block:
if it does, every classified turn carries a guaranteed system-tier divergence and system-level
attributions from that path are suspect; if it does not, the path is sound as-is. Decide it by
diffing two consecutive same-stream request bodies from `/Volumes/AgentLensSpool/otel-bodies` —
separate the streams FIRST (a subagent shares the parent's session id; diffing across streams
manufactures a divergence at index 0 every time, which cost two wrong conclusions on 2026-08-04).

**SUPERSEDED — do NOT carry forward:** "our cache-break classifier has no breakpoint model" as a
statement about the product as a whole; it is true only of the composition path.

## The defect (as originally written — read with the STATE block above)

`analyzeCacheBreaks` / `firstDivergentBlock` (`src/shared/cacheBreak.ts`) name a culprit by
**set-diffing the injected context blocks between two turns and taking the first one that changed**.
That criterion is not the API's.

The API caches the prefix **ending at a `cache_control` breakpoint**, and finds a hit by walking
backward at most **20 blocks** looking for an entry a prior request actually wrote. Consequences our
classifier does not model:

- A block that changed **after** the governing breakpoint cannot have caused the miss.
- A block that changed **before the first breakpoint** may not decide the hit either.
- A break can occur with **no block changed at all** — the 20-block lookback overrunning is
  sufficient on a tool-heavy turn.

So the classifier can, with full confidence, name a block that provably could not have caused the
break. Everything downstream inherits the error: `get_cache_break_causes`, `get_cache_break_timeline`,
the burn reports, and the hook warnings that quote them.

## The measurement that exposed it (2026-08-04, this machine, live session)

Breakpoint layout observed in real request bodies (`/Volumes/AgentLensSpool/otel-bodies`), stable
across the sample — **3 of the 4 allowed breakpoints**:

```
system[2]=1h   system[3]=1h   msg[LAST].0=1h      # main conversation on a subscription
system[2]=5m   system[3]=5m   msg[N].2=5m         # the interleaved 5m stream
```

And the fact that falsifies the current criterion outright:

> **`system[0]` (the `x-anthropic-billing-header` block) changes on EVERY request, while those same
> turns bill 0.3–0.7% write and read ~440k warm.**

If "first divergent block" were the criterion, every turn would be a full cold rewrite. They are not.
A block before the first breakpoint does not decide the hit, and our classifier has no way to know
that because it has no breakpoint model.

## Why this matters more than adding causes

This was found while chasing a real 399,123-token cold write ($4.02, one turn) that
`get_cache_break_timeline` attributed to `HOOK_INJECTION — hook block changed at pos 323`. That
attribution may be right, but the tool cannot currently justify it, and acting on it nearly
reproduced the documented error in the USER memory page
`hook-injection-breaks-the-prompt-cache` `[^3]`: *"DO NOT convert a diagnostic tool's LABEL into an
OWNER"* — an error that already reached a TRDD, a commit message and a memory note once.

**A wrong culprit is worse than no culprit**: it sends someone to fix the wrong component, and it
launders a guess into a number.

## Acceptance criteria

- [ ] The analyzer parses `cache_control` markers from the raw request bodies (positions + `ttl`)
      rather than assuming a layout — the layout above is *measured*, not contractual, and Claude
      Code may change it.
- [ ] A candidate culprit is rejected when it sits **after** the governing breakpoint.
- [ ] Blocks before the first breakpoint are handled explicitly, with the chosen semantics stated in
      a comment and pinned by a test (the `system[0]`-changes-every-turn case above is the fixture).
- [ ] `LOOKBACK_OVERFLOW` is representable: a break with **no changed block** and ≥20 blocks added
      since the last write is classified as such, not as `UNKNOWN`.
- [ ] When the evidence cannot justify a single culprit, the verdict says so instead of naming the
      first divergent block. An honest `UNATTRIBUTABLE` beats a confident wrong name.
- [ ] Tests use real captured bodies, not synthesised block lists — the two method errors that
      produced this TRDD (cross-stream diffing, breakpoint-blind diffing) were both invisible to
      synthetic fixtures.
- [ ] `get_cache_break_timeline`'s cause codes and `CacheBreakCause` are reconciled, or their
      relationship documented — they are currently two different taxonomies (25-ish vs 18) and
      `CLAUDE.md` cites only the latter.

## Not in scope

Adding the ~18 documented-but-unmodelled causes (worktree/cwd prefix split, git-status drift,
opusplan toggle, safety-classifier fallback, involuntary MCP churn, below-minimum prompt length,
citations/tool_choice/thinking-config/web-search/speed toggles, workspace isolation, unstable
`tool_use` key order, concurrent-before-first-response, `DISABLE_PROMPT_CACHING*`). That is its own
task and is **blocked by this one** — adding causes to a classifier whose attribution method is
unsound multiplies the wrong answers rather than reducing them.

## Evidence

- `reports/cache-invalidation-research/` — 7 reports over 15 doc pages (2026-08-04)
- `reports/image-cache-test/20260804_144500+0200-image-append-cache-measurement.md`
- USER memory `hook-injection-breaks-the-prompt-cache` `[^1]` and `[^3]`
- `CLAUDE.md` §"HOW TOKEN USAGE / CACHE ECONOMICS WORK" (corrected in `a8e6869`)
