---
trdd-id: OCNHOHE9
title: CLI cache-expiry probe — is a session past its prompt-cache TTL
column: dev
created: 2026-07-13T21:52:20+0200
updated: 2026-07-13T21:52:20+0200
current-owner: main
task-type: feature
scope: project
relevant-rules: []
parent-trdd: VY1IUVUM
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-13

**Component states**
- `src/cacheExpiry.ts` (pure assessment) — DONE. `assessCacheExpiry` + `formatIdle`, reuses `classifyTtlRegime`.
- `src/test/cacheExpiry.test.ts` (unit) — DONE, 15 tests PASS under Node 20 (mocha `ui:tdd` → `suite`/`test`).
- `check_cache_expiry` MCP tool in `src/mcpServer.ts` — DONE. `handleCheckCacheExpiry` + `lastLlmRequestMs` +
  tool def + switch case; `check-types` GREEN both runtimes. Auto-exposes as `agentlenspro check_cache_expiry`.
- docs — DONE: diagnostics skill (recipes + cheat-sheet row), README (count-free), CHANGELOG [Unreleased], CLAUDE.md.
- Incidental fix: README + CLAUDE.md "32 diagnostic tools" was stale (real count 41) → made count-free (drift-proof).

**NEXT ACTION**: run `bash scripts/safe-deploy.sh --dry-run` (full gate under Node 20); then `node esbuild.js` +
live smoke `agentlenspro check_cache_expiry --all`; then commit on `feat/cache-expiry-probe`.

**Load-bearing facts**
- The TTL model is DONE in `src/shared/cacheTtl.ts`: `classifyTtlRegime(kind, ctx) → { ttlMs, ttlAssumedMin, ttlSource, ttlBasis }`, `sessionTtlKindOf(card) → 'main'|'subagent'|'fork'`, `ttlPhrase(regime)`. REUSE — never re-encode a TTL number (there is a grep test `ttlLiterals.test.ts` that fails on a re-declared 5-min literal).
- Auth context: `getTtlContext(fiveHourPctConsumed, opts) → TtlContext` (`src/ttlContext.ts`). Already wired into `mcpServer.ts` as the `getTtlContext?: () => TtlContext` handler accessor (≈L2449/2484/2575) — the tool handler calls `getTtlContext?.() ?? null`.
- "Last LLM request" = the freshest `TimelineEntry` of `type === 'api_request'` (log-derived, ground-truth billed call, carries `timestamp` ISO + `costUsd`). Fall back to `type === 'llm'` only if no `api_request` exists.
- Diagnostic tools are AUTO-exposed by the generic CLI dispatch (`agentlenspro <tool> --param value --out FILE`) — no new CLI verb code needed once the MCP tool exists.
- HONESTY CONTRACT (inherited from cacheTtl): never guess. No last-request ts → `verdict: 'unknown'` with reason. ctx auth unknown / kind null → regime already returns `ttlSource: 'assumed'`; surface it, do not present an assumed number as fact.

**SUPERSEDED — do NOT carry forward**: none yet.

## Problem

A user wants to know, for "a certain claude", whether more than the prompt-cache TTL
has elapsed since its last LLM request — i.e. whether the next request will pay a full
cache-creation write (~1.25× the prefix) because the cached prefix was evicted. Today the
data exists (session cards with `api_request` timeline entries + the doc-verified TTL
regime) but there is no single probe that answers "is this session's cache cold yet?".

The user framed it as "more than 1h" — which is exactly the subscription-MAIN tier. But a
correct probe must use the PER-SESSION TTL (subagents are 5-min ALWAYS, usage-credits main
is 5-min), so a hardcoded 1h would misreport subagents/forks. Default to the resolved
regime; allow an explicit `--threshold-minutes` override for users who want a fixed cutoff.

## Design

**Pure core** `src/cacheExpiry.ts` — runtime-neutral, no Node/DOM:
```
interface CacheExpiryInput { lastRequestAtMs: number | null; nowMs: number;
                             kind: SessionTtlKind | null; ctx: TtlContext | null;
                             thresholdMs?: number }   // explicit override wins over regime.ttlMs
interface CacheExpiryVerdict {
  verdict: 'fresh' | 'expired' | 'unknown';
  idleMs: number | null; idleHuman: string | null;
  ttlMs: number; ttlMin: number; ttlSource: TtlSource; ttlBasis: string;
  marginMs: number | null;   // ttlMs - idleMs; negative when expired
  usedThresholdOverride: boolean;
  reason: string;            // one human line; the WHY when verdict==='unknown'
}
function assessCacheExpiry(input): CacheExpiryVerdict
```
Rules: `lastRequestAtMs === null` → `unknown` (reason "no LLM request recorded for this
session"). Else classify the regime (or use thresholdMs override), `idleMs = now - last`,
`expired = idleMs > ttlMs`. Every cache HIT resets the timer, so idle is measured from the
LAST request — correct by construction. `idleHuman` formatted compactly (e.g. "1h 12m").

**MCP tool** `check_cache_expiry` (server-side, in mcpServer.ts):
- args: `sessionId?` (default = most-recent MAIN session), `thresholdMinutes?`, `all?` (bool
  — every recent session with its verdict).
- resolves each target card → last `api_request` ts → `assessCacheExpiry({..., kind:
  sessionTtlKindOf(card), ctx: getTtlContext?.() ?? null})` → verdict object.
- returns `{ session(s): [...] }`; digest line to stdout, full JSON to `--out`.

## Verification
- `src/test/cacheExpiry.test.ts`: main-subscription 1h fresh/expired/boundary; subagent 5m
  (auth-independent); usage-credits main 5m; unknown-ctx → assumed regime surfaced;
  null last-request → verdict 'unknown'; explicit threshold override wins + sets flag;
  idleHuman formatting.
- `bash scripts/safe-deploy.sh --dry-run` GREEN (check-types ×2 → lint → check-mirrors →
  compile-tests → full Mocha under Node 20).
- Live smoke: `node esbuild.js` then `agentlenspro check_cache_expiry --all` against the
  running server; confirm a just-active session reads `fresh` and its idle grows.

## Approval log
- Tier 0 (agent-independent): in-scope feature on the project's own CLI, reversible, no
  baseline/governance/release surface touched. User explicitly requested it.
