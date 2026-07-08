---
name: agentlens-burn-token-model
description: "5h/7d account window drained fast / burning 1M+ tokens per minute / what is consuming all the tokens / impossible that a few Claude sessions burned the window / cost vs token window limit / cache-read dominating burn"
ocd: 2026-07-08
lmd: 2026-07-08
metadata:
  node_type: memory
  tier: hub
  type: project
  globs: ["src/burnMonitor.ts", "src/statuslineUsage.ts", "media/src/tabs/Alerts.tsx"]
---

# AgentLens burn / token-consumption model

**The recurring question — "what is consuming all these tokens? / the 5h window drained in a breath":**
On real Claude Code workloads **~96% of every consumed token is `cache_read`** — the resident context
(a large CLAUDE.md + `~/.claude/rules/*` + MCP tool schemas [lean-ctx ~100 tools, codegraph,
chrome-devtools] + the accumulated marathon transcript) **re-read on every single turn**. Fresh input
~0.1%, output ~0.2%, cache-create ~3-4%. So a session doing a few turns/min over a 300-400k-token
resident context "consumes" millions of cache-read tokens/min — huge COUNT, but cache-read is billed
0.1× input, so cheap in dollars. N concurrent marathon sessions multiply it. It is NOT phantom
double-counting (usage is deduped by Anthropic `message.id`).

**Root cause = resident-context floor (~300-400k/turn) × marathon turn count × N concurrent sessions.**
Levers to cut burn, biggest first: (1) shrink the per-turn floor — trim CLAUDE.md + rules + shed unused
MCP servers; (2) don't run many marathon sessions at once; (3) start fresh sessions (the transcript
floor resets) instead of 2000-turn ones.

**Cost-vs-token nuance (important):** the rate/window numbers in `burnMonitor.ts` sum all 4 buckets
equally, so raw tokens over-state consumption if a plan's window is COST-based. BUT even cost-weighted
(cache-read 0.1×), cache-read stays ~70% of the window's billable weight — its sheer volume wins. Raw 5h
≈ 227M tokens ↔ cost-weighted ≈ 31M input-equivalents (7.3×) ↔ actual cost ≈ $897; read
`consumedCostUsd` / `consumedBillableWeighted`, not raw tokens, to judge a cost-based window.

**Where it lives:** `src/burnMonitor.ts` — `ConsumptionEvent` (2 sources: OTEL `api_request` rich +
statusline billing deltas), `BurnRateWindow.breakdown` + `billableWeightedPerMin`, `WindowConsumption`
(5h/7d), `BILLABLE_WEIGHTS` (output 5×, cacheRead 0.1×, cacheCreate 1.25× — model-independent, NOT
Anthropic's undisclosed window weighting). `src/statuslineUsage.ts` carries the per-turn bucket split
onto the statusline event (no-OTEL sessions). Webview `BurnBreakdownBar` in the Alerts config section.
`/api/burn-status` + SSE (4s tick) + MCP `get_burn_status`/`get_session_status`.

**Known GAP (tracked in TRDD-BURNWDGT):** the window budget pools consumption **machine-wide across all
accounts** — WRONG, because rate limits are **per OAuth account** (token in the macOS keychain). Rotating
accounts mid-window must not pool. Also missing: cost-based capacity, empirical capacity calibration
(measure consumed at a PREMATURE window end = a rate-limit hit, NOT a time rollover), and account/plan
awareness (current account, plan type, % 5h + % 7d remaining). See [[agentlens-account-window-budget]].

## Notes and lessons learned
[^1]: [ocd:2026-07-08 lmd:2026-07-08] The statusline event path originally carried only a total
  (`deltaTokens`), so the per-bucket breakdown landed 100% in `unknown` for exactly the no-OTEL sessions
  the burn monitor watches — the breakdown looked broken until the split was threaded through
  `StatuslineBillingEvent` (commit d3c04b1). Lesson: when adding a per-bucket view, verify it against the
  LIVE event source (statusline), not just the rich OTEL path — most live sessions have no OTEL.
