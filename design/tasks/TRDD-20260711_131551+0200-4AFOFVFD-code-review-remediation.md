---
trdd-id: 4AFOFVFD
title: Code-review remediation — 16 fixed + merged, 7 deferred to implement
column: dev
created: 2026-07-11T13:15:51+0200
updated: 2026-07-11T13:15:51+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 2
severity: HIGH
effort: L
labels: [security, correctness, review, ingest, pricing]
task-type: bugfix
parent-trdd: null
npt: []
eht: []
blocked-by: []
supersedes: []
superseded-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
feature-branch: fix/code-review-security-correctness
merge-strategy: merge
must-pass-tests-before-merge: true
publish-target: npm
publish-channel: stable
test-requirements: [unit, lint, typecheck]
audit-requirements: [security-scan]
review-requirements: [code-review]
runtime-targets: [macos, linux]
impacts: [public-api]
attempts: 1
test-failures: 0
last-test-result: pass
last-test-at: 2026-07-11T13:00:00+0200
implementation-commits: [7d89ad3, a03ee4b, 8150494, 36728a6, fb94170]
pr-url: null
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-11

**What this is:** the remediation record for a whole-codebase xhigh code review
(3 parallel Opus reviewers over ~45k LOC, all 10 angles each, + an orchestrator
security sweep). 23 findings total.

**DONE (16 findings) — committed + merged to `main`, gate green 862/0:**
Security CRITICAL×2 + HIGH×1, MEDIUM×5, LOW×8. Merge commit `fb94170`
(`--no-ff`). Full detail:
`reports/code-review/20260711_125246+0200-CONSOLIDATED-review-and-fixes.md`
and the three per-slice reports alongside it. 4 regression tests added
(path-traversal, silent-$0 pricing ×2, loadBurnConfig(null)).

**NOT LIVE YET:** the linked dogfood bundle (`npm link`) still runs pre-fix code
until a real `pnpm run deploy:safe` (build + restart) is run — deliberately left
for the owner to trigger (live to every agent on the machine).

**NEXT ACTION — implement the 7 DEFERRED findings (this TRDD's open work), each
with a regression test, gating after each:**
1. S3-F3 — unify OTLP ingest (kill `OtlpCollector` production drift). HIGHEST RISK.
2. S3-F5 — hookInstall TOCTOU (no stale whole-array `set`).
3. S1-F6 — OpenCode WAL commit-boundary (don't surface uncommitted frames).
4. S1-F9 — per-turn fast-mode pricing (no whole-session `-fast` stamp).
5. S1-F8 — match each `tool_result` to its own `toolUseResult` (or enforce+doc 1:1).
6. S1-F7 — define `SessionStore.tokensUsed` precisely (no bucket double-count).
7. S2-F5 — thread the model's `cacheReadPerMTok` into `priceWaste` (drop hardcoded 0.1×).

**Load-bearing facts / gotchas:**
- `pnpm`/`tsc`/`esbuild` run under default Node (26 here); the Mocha suite runs
  under Node 20 — pnpm CRASHES under Node 20. `bash scripts/safe-deploy.sh
  --dry-run` is the authoritative gate (auto-resolves Node 20 for mocha).
- The SQLite `src/database/*` + `sessionStore`/`otlpCollector`/`otlpParser`
  layer is the LEGACY VS Code path — NOT constructed by the live standalone
  product (verified grep 0). Findings 9/10/13 (done) and S1-F6/S1-F7 (pending)
  live there: real, test-covered, reactivatable, not on the hot path.
- The live product persists via `SegmentedSpanStore` + `collectorState` sidecar,
  and ingests via the standalone server's OWN inline `processLogs`/`processTraces`
  (NOT `OtlpCollector`). That divergence IS S3-F3.
- LSP diagnostics on `standalone/server.ts` about `computeBurnStatus` arg-count /
  `AgentGateState.ttl` are STALE (pre-TTL-work signature); real `tsc` is 0-error.
  Trust `pnpm run check-types`, not the editor squiggles.

**SUPERSEDED — do NOT carry forward:** my initial per-finding "skip" rationale.
The owner directed that all 7 deferred findings BE implemented (this turn), so
they are open work, not skips.

**Durable artifacts to read before acting:**
- `reports/code-review/20260711_125246+0200-CONSOLIDATED-review-and-fixes.md`
- `reports/code-review/20260711_121226+0200-slice{1,2,3}-*.md`

---

## Review methodology

Whole current source (~45k LOC) partitioned across 3 parallel Opus reviewers
(ingestion+persistence; accounting+burn+MCP; server+CLI+config+webview), each
running 10 angles (line-by-line, missing-guard, cross-file tracer, language
pitfalls, wrapper correctness, reuse, simplification, efficiency, altitude,
CLAUDE.md conventions) against a shared spec encoding the project invariants
(four disjoint token buckets, single-source feed-merge, `safeConfigEdit`-only
config writes, no `src/shared/` mirrors, TTL regime matrix, fail-open gate).
Orchestrator pooled/deduped, ran a security-focused gap sweep (which found the
sharpest bug — the cross-origin arbitrary-file-write → RCE), applied fixes,
added regression tests, and gated (858→862, 0 failing).

## Completed findings (16) — merged in `fb94170`

| ID | Sev | File | One-line |
|---|---|---|---|
| S3-F1 | CRIT | generatedFiles.ts | path-traversal read → realpath containment |
| SWEEP | CRIT | server.ts | cross-origin arbitrary-file write→RCE → CSRF Origin gate + allowlist |
| S3-F2 | HIGH | server.ts | osascript shell injection → execFile (no shell) |
| S3-F4 | MED | server.ts | uncapped POST bodies → readBodyCapped helper (6 handlers) |
| S2-F1 | MED | pricing.ts | gpt-5 silently $0 → longest-match, null on unknown |
| S2-F2 | MED | forensicsIndex.ts | billable_weight drops no-split cache-creation → synthesize 5m |
| S2-F3 | MED | burnMonitor.ts | loadBurnConfig crash on JSON null → coerce to {} |
| S1-F1 | MED | spanSummarizer.ts, utils.ts | cacheHitRate >1 → context denominator |
| S1-F2 | MED | retention.ts | orphaned children + leaked blobs → explicit child-first deletes |
| S1-F3 | MED | reader.ts | daily/hourly totalTokens excludes output → match doc+lifetime |
| S3-F6 | LOW | server.ts | burn-risk/status omit ttlContext → pass it |
| S3-F7 | LOW | server.ts | static-serve prefix → mediaDir + path.sep |
| S1-F4 | LOW | reader.ts | queryBurnRate div-by-zero → guard |
| S2-F4 | LOW | capacityCalibration.ts | Math.min spread → reduce |
| S2-F6 | LOW | forensicsCompare.ts | "-50% more" wording → abs() |
| S2-F7/MINE | LOW | burnMonitor.ts, safe-deploy.sh | cardCostUsd falsy-zero → samples>0; `--` separator |

## Deferred findings (7) — the open work order

### 1. S3-F3 [MEDIUM, highest risk] — unify OTLP ingest, kill OtlpCollector drift
- **Where:** `standalone/server.ts` inline `processLogs`/`processTraces` vs the
  unit-tested-but-unused `src/otlpCollector.ts`.
- **Bug:** the tested class is dead in production; the shipped inline path is
  MISSING `gen_ai.choice`/`gen_ai.assistant.message` response-content buffering
  and the full Codex session normalization the tests validate → gen_ai response
  text silently dropped, Codex sessions grouped differently than tested.
- **Fix approach:** extract the shared ingest logic into one module both the
  (retained) collector and the standalone call — OR delete the dead class and
  move its tests onto the inline functions so tests exercise shipped code.
- **Test:** a test that drives the ACTUAL shipped ingest path with a
  gen_ai response event + a multi-prompt Codex conversation.

### 2. S3-F5 [LOW] — hookInstall TOCTOU
- **Where:** `src/cli/hookInstall.ts` — reads settings, computes `r.rebuilt`,
  hands `safeConfigEdit` a whole-array `set` of `hooks.<ev>`.
- **Bug:** a foreign hook appended to the same event between the read and the
  transaction is clobbered (the set derives from the stale snapshot).
- **Fix approach:** recompute the strip/append INSIDE a single transactional
  read, or add a merge op to safeConfigEdit.
- **Test:** concurrent-add simulation preserving a foreign entry.

### 3. S1-F6 [LOW] — OpenCode WAL commit-boundary
- **Where:** `src/logReader.ts` `_mergeWal`.
- **Bug:** applies every salt-matching frame with no commit-boundary stop, so an
  in-flight (uncommitted) transaction can surface as committed rows.
- **Fix approach:** track the running page image but only COMMIT up to the frame
  whose `dbSize != 0` (last valid commit frame); discard trailing non-commit
  frames. WAL-semantics — test carefully.
- **Test:** a synthetic WAL with a committed txn + trailing uncommitted frames.

### 4. S1-F9 [LOW] — per-turn fast-mode pricing
- **Where:** `src/logReader.ts:443` `effectiveModel = hasFastMode ? \`${model}-fast\``.
- **Bug:** one fast turn flips the whole card to `-fast`, mis-pricing a mixed session.
- **Fix approach:** price per-turn from each entry's own speed, or scope the suffix.
- **Test:** a mixed standard+fast session costs less than an all-fast one.

### 5. S1-F8 [LOW] — tool_result → toolUseResult attribution
- **Where:** `src/logReader.ts` `_claudeOnEntry`/`_resolveToolResult`.
- **Bug:** one entry-level `toolUseResult` is attributed to EVERY `tool_result`
  block in the entry → sibling sub-agents mis-attributed if multi-result entries occur.
- **Fix approach:** match each `tool_result` to its own `toolUseResult` by
  `tool_use_id`, or enforce + document the 1:1 assumption.
- **Test:** a multi-tool_result user entry attributes each to its own usage.

### 6. S1-F7 [LOW] — SessionStore.tokensUsed double-count
- **Where:** `src/sessionStore.ts` `updateSummary`.
- **Bug:** sums raw-input keys AND gen_ai.* keys AND cache AND output into one scalar.
- **Fix approach:** define it precisely (one key-family per provider; a clean
  "total context" = raw+cacheRead+cacheCreate+output).
- **Test:** a span with both `input_tokens` and `gen_ai.usage.input_tokens` isn't double-counted.

### 7. S2-F5 [LOW] — cacheBreak priceWaste hardcoded 0.1×
- **Where:** `src/shared/cacheBreak.ts` `priceWaste`.
- **Bug:** `write - 0.1*input` hardcodes the cache-read multiplier; wrong for
  non-0.1× models (e.g. codex-mini at 0.25×).
- **Fix approach:** thread the model's `cacheReadPerMTok` into `AnalyzeCacheBreaksOpts`.
- **Test:** a non-0.1× model yields the model-correct wasted figure.

## Approval log
- 2026-07-11 — owner directed: implement ALL deferred findings correctly + test
  (no skips). This TRDD tracks that remediation.
