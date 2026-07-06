---
trdd-id: TKN5VALS
title: Fix Claude token/cost accounting + 5-value expandable trace tree, sticky headers, Context tab
column: dev
created: 2026-07-06T01:16:34+0200
updated: 2026-07-06T01:16:34+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 2
severity: HIGH
effort: XL
task-type: bugfix
parent-trdd: null
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: [config-schema]
migration-direction: forward
attempts: 0
implementation-commits: []
external-refs: []
---

# TRDD-TKN5VALS — Token/cost accuracy + expandable 5-value trace tree

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-06

**User's verbatim work order (7 items):** costs wrong (9.2k tokens → $6.67);
10M+ tokens reported vs ~15-20k manual sum; trace expansion missing cache
read/write; can't expand event→turn→tool with the 5 values each + a bar of the
selected value above; the metric bars + filter field scroll instead of being
fixed headers like the tabs; sub-agents/forks ignored in totals; add a tab next
to Trace showing context-size trace after each event with turn numbers and
sub-agent/fork sessions as expandable sub-branches.

**Two DECISIONS made by user (2026-07-06):**
1. Headline "tokens" = NEW tokens = `input(uncached) + output + cache-write`.
   cache-read is shown as its OWN labeled value/bar, NEVER folded into the
   headline. Cost still billed on ALL buckets (incl. cache-read).
2. Sequence: **P1 accounting first** (items 1,2,6) → verify → commit; then
   **P2 UI** (items 3,4,5,7) → verify → commit. Separate commits.

**ROOT CAUSES (✓ VERIFIED, file:line):**
- Items 1+2 = ONE bug. `src/logReader.ts:1634` `card.inputTokens = totalInput +
  totalCacheRead + totalCacheCreate` (= totalContext). cacheRead ≈ whole
  transcript re-read each turn, summed over N turns → millions. `writer.ts:152`
  bills `cost_usd` off that same base via
  `calcTokenCostUsd(inputTokens − cacheRead − cacheCreate, cacheRead, cacheCreate, output, model)`.
  So cost is consistent with the STORED (inflated) total but absurd vs a smaller
  displayed figure. Commit 74b7625 fixed only per-ROW dup, not per-TURN cacheRead.
- Item 6. No parent←child rollup. `src/logReader.ts:824` literal
  `// Subagent session attribution is left for a follow-up.` Sidechain only
  TAGGED `initiator:'agent'` at `:1467-1470`; child tokens stay in their own
  session file, invisible to parent.
- Items 3/4/5/7. Trace = flat one-level `TimelineEntry[]`
  (`media/src/tabs/Traces.tsx:523`). Only `type:'llm'` rows carry the 4 token
  fields; cost derived at render (`calcEntryCost`). Only `.tabs` is sticky
  (`media/src/styles/tabs.css:23`); metric bar (re-rendered per SessionBlock),
  filter, time-picker, tab-stats all scroll. No `turn` number, no parent/child
  session link webview-side. Growth chart already has `{turn, tokens, spanId}`
  per-turn series (`media/src/tabs/SessionCharts.tsx:302`).

**PROGRESS (2026-07-06, UPDATED post-resume ~ current session):**
- ✓ **P1 COMPLETE** — committed across `4d28f24`, `a98f480`, `9a672fa`. `pnpm run
  check-types` (src + media) is CLEAN on the current tree. Specifically:
  - P1.1: de-inflate stored `input_tokens` (raw uncached input only); `writer.ts`
    cost bills 4 disjoint buckets directly. Cost value unchanged, total de-inflated.
  - P1.2: `media/src/sessionMetrics.ts` bills raw input directly (a98f480).
  - P1.3: sub-agent/worktree/fleet child transcripts linked to parent project
    (9a672fa) — `parentSessionId` backbone wired extension-side.
  - Type backbone (`turn?`, `parentSessionId?`) present in summarizerTypes + types.
- ✗ **P2 NOT STARTED** (verified: no `media/src/tabs/ContextTab.tsx`; no `turn`/
  `parentSessionId` usage in `media/src/tabs/Traces.tsx`). All of P2.1 (sticky
  headers), P2.2 (4-level 5-value tree), P2.3 (Context tab + sub-branches) remain.
- ✗ **P3 NOT STARTED** (context-composition tracer; heavy, explicitly after P2).

**NEXT ACTION:** Implement P2 in the webview (P2.1→P2.2→P2.3), verify
check-types+lint clean + drive dashboard headless, commit `feat(dashboard): …`.
Then P3. Delegated to a fresh-context agent to keep the orchestrator thin.

**SUPERSEDED — do NOT carry forward:** the older "STILL TODO in P1" list (P1.2/P1.3
were open at 01:20) — P1 is now fully committed and typecheck-clean. Line-number
refs in ROOT CAUSES (e.g. `logReader.ts:1634`) are pre-P1-fix and have shifted.

**Durable artifacts to read before acting:**
- reports/token-accounting/20260706_011126+0200-investigation.md
- reports/trace-ui/20260706_011112+0200-investigation.md

---

## P1 — Accounting correctness (extension host; items 1, 2, 6)

Files: `src/logReader.ts`, `src/database/writer.ts`, `src/database/schema.ts`,
`src/database/reader.ts`, `src/database/migration.ts`, `src/types.ts` +
`media/src/types.ts` (mirror), `src/sessionRepository.ts`,
`media/src/pricing.ts` / `media/src/sessionMetrics.ts` / `media/src/TokenTotals.tsx`
(display side). Keep phase ≤ the coherent accounting-core cluster.

### P1.1 — De-inflate the stored total (items 1+2)
- `src/logReader.ts:1634`: STOP setting `card.inputTokens = totalContext`.
  Set `card.inputTokens = totalInput` (raw uncached input only). The card
  already carries `cacheReadTokens`, `cacheCreateTokens`, `outputTokens`
  separately — keep those. Add/confirm the card exposes all 4 raw buckets.
- DERIVED (mandatory, same edit): `src/database/writer.ts:152` cost calc used
  `inputTokens − cacheRead − cacheCreate` to reconstruct raw input. Now that
  `inputTokens` IS already raw, change to
  `calcTokenCostUsd(inputTokens, cacheRead, cacheCreate, output, model)` (no
  subtraction). VERIFY the money math: dump one real session's 4 buckets and
  confirm cost matches hand-calc at the model's rates. This must not regress cost.
- DERIVED: audit every reader of the `input_tokens` column
  (`src/database/reader.ts`, `src/sessionRepository.ts`, any summarizer, the OTLP
  path `spanSummarizer`/`sessionStore`) — anything treating `input_tokens` as
  "total context" must be updated to the new meaning (raw input) or compute the
  headline as input+output+cacheCreate.
- DERIVED (schema/migration): existing rows hold totalContext in `input_tokens`;
  new rows hold totalInput. Decide: (a) a forward migration that can't recompute
  (data lost) → simplest is to bump the DB/schema version so stale rows are
  re-ingested from logs, OR (b) leave old rows and document the discontinuity.
  Prefer re-ingest if the retention/migration path supports a clean rebuild.

### P1.2 — Headline = new tokens; cache-read split out (display)
- Trace the webview headline field FIRST. Then compute the headline everywhere as
  `input + output + cacheCreate` (NEW tokens). Render `cacheRead` as its own
  labeled value/bar, never inside the headline. Cost unchanged (all buckets).
- Files likely: `media/src/pricing.ts`, `media/src/sessionMetrics.ts`,
  `media/src/TokenTotals.tsx`, `media/src/tabs/*` headline sites.

### P1.3 — Sub-agent / fork rollup (item 6)
- Implement the deferred attribution at `src/logReader.ts:824`. Link child
  (sidechain / Task / fork) session files to their parent via
  `sessionId`/`parentUuid` and roll child `totalInput/Output/CacheRead/CacheCreate`
  INTO the parent card's aggregated total, AND retain the child as a distinct
  session so P2 can render it as an expandable sub-branch.
- DERIVED (feeds P2): add to BOTH `src/types.ts` and `media/src/types.ts`
  (mirror) a `parentSessionId?: string` (or `spawnedBySessionId`) on the session
  summary, and a `turn?: number` on `TimelineEntry`. Populate extension-side in
  the summarizers + `src/dashboardPanel.ts` payload. These are the backbone for
  items 4 & 7.

### P1 verification
`pnpm run check-types` (twice: src + media) + `pnpm run lint` clean; relevant
unit tests (`src/test/**`) pass; hand-verify one real session: headline ≈ manual
sum, cost sane (cents-to-low-dollars for a small session), sub-agent tokens now
appear in parent total. Commit `fix(accounting): …`.

## P2 — Trace UI rework (webview; items 3, 4, 5, 7)

### P2.1 — Sticky headers (item 5)
- Lift the metric-toggle bar out of per-`SessionBlock` `TimelineWaterfall` into
  the Traces tab shell; hoist its `metric` state to a signal (`state.ts`).
- Wrap non-entry chrome (metric bar + filter field + time-range picker +
  tab-stats) in a `position:sticky; top:<tabs-height>` band so ONLY the entry
  list scrolls beneath. Respect the no-nested-scrollbars rule (page scrolls, not
  an inner box). CSS in `media/src/styles/` (waterfall.css/tabs.css/base.css).

### P2.2 — 4-level expandable tree with the 5 values (items 3, 4)
- Make step rows recursive: session → event → turn → command/tool. Each level
  shows all 5 values (input, output, cache-read, cache-write, cost); parent
  levels = sum of children. A bar of the currently-selected metric renders above
  the list (driven by the hoisted `metric` signal). Turn number from P1's
  `turn` field. Keep `highlightSpanId`/`focusedTurn` working per-leaf.

### P2.3 — Context Size tab + sub-branches (item 7)
- New tab `Context` next to Trace (recipe: `media/src/App.tsx` TABS array +
  `ActivePanel` switch + new `media/src/tabs/ContextTab.tsx`).
- Show cumulative context size after each event/tool/command/message (running
  sum of the true context = input + cacheRead per step) with turn numbers.
- Render sub-agent/fork sessions as EXPANDABLE SUB-BRANCHES of the parent
  session using P1's `parentSessionId`. Nested SessionBlocks.

### P2 verification
check-types + lint clean; drive the dashboard (headless) to confirm: sticky
headers don't scroll; expand session→event→turn→tool shows 5 values each; metric
bar above updates on toggle; Context tab renders with turn numbers and expandable
sub-branches. Commit `feat(dashboard): …`.

## P3 — Context-composition tracer (EXPANDED SCOPE, user 2026-07-06)

Goal: see, per step, EXACTLY what occupies the context window and what it costs —
every event, message, tool call, inherited context file (CLAUDE.md, each rule,
each memory), hook injection, and sub-agent sub-session — across ALL sessions,
with exact tokens + cost + timestamp. The user wants to diagnose token burn to
the single injected file.

### Feasibility (✓ VERIFIED against a real `.jsonl` 2026-07-06 — this session's log)
The Claude Code `~/.claude/projects/<proj>/<session>.jsonl` is rich enough:
- Entry `type`s seen: `assistant`, `user`, `system`, `attachment`,
  `file-history-snapshot`, `last-prompt`, `mode`, `permission-mode`,
  `queue-operation`, `ai-title`.
- **`attachment` (10,419 in one session)** = the injected context blobs — every
  CLAUDE.md / rule / memory / file-read that enters context. TOKENIZE each to get
  per-source context weight per step. THIS is the enabler for "which file eats
  the context".
- **`system` entries carry `hookAdditionalContext`** = hook injections
  (janitor-memory, pss-skills, token-guard) — attributable too.
- **`assistant.message.usage`** = the 5 token buckets per turn (input/output/
  cache_read/cache_creation) → per-turn cost.
- **`parentUuid`** threads the full event→turn→tool tree; `toolUseID` /
  `sourceToolAssistantUUID` / `toolUseResult` link tool calls ↔ results.
- Sub-agents are SEPARATE session files (`isSidechain==true` was 0 in the main
  session — Agent-tool spawns wrote their own `.jsonl`) → needs CROSS-FILE
  linkage (P1.3's `parentSessionId`), matched via spawn time / cwd / Task tool_use.

### P3 build (after P1+P2)
- Extend the log parser to emit, per step: a context-composition breakdown =
  list of {source (file path / rule / memory / hook / tool-result / message),
  tokens, cost, added-at timestamp, still-resident?}. Tokenize attachments
  (approx tokenizer OK — label as estimate).
- Running context-size series already seeded by P2.3's Context tab; enrich each
  point with its composition breakdown (drill-down: click a step → see the N
  sources occupying context there, sorted by weight).
- Cross-session: ingest ALL project sessions (not just the open one) so ANIME2SVG
  + sub-agent sub-sessions are all visible; render sub-agent sessions as
  expandable branches under the spawning turn.
- The harness floor (CLAUDE.md + rules + tool catalog) becomes an explicit,
  sized line item per turn — the thing currently invisible in the turn breakdown.
- DERIVED: this is heavy data; lazy-load per session, stream, and cap the
  attachment tokenization (don't load 10k attachments into the webview at once).

### P3 verification
Reconcile against claude.ai account dashboard for a window; the per-step
composition sizes should sum (± tokenizer error) to that turn's cache_read+input.

## Notes / gotchas
- `src/types.ts` ↔ `media/src/types.ts` MIRROR — change BOTH on any shape change.
- Two pricing tables hand-synced (`src/pricing.ts` write-time, `media/src/pricing.ts`
  display-time) — cost logic changes may touch both.
- Branch `fix/logreader-large-jsonl`; commits stay LOCAL (origin is upstream
  RogerReed/agentlens — do NOT push). Stage files by name (never `git add -A`).
