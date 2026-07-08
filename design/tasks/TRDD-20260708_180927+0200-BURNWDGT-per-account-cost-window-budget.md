---
trdd-id: BURNWDGT
title: Per-account, cost-aware, self-calibrating token-window budget + account/plan awareness
column: complete
created: 2026-07-08T18:09:27+0200
updated: 2026-07-08T22:36:25+0200
current-owner: 777b8f52
assignee: 777b8f52
priority: 1
severity: HIGH
effort: L
labels: [burn, window-budget, account-awareness, cost-accounting]
task-type: feature
parent-trdd: null
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: main
feature-branch: fix/logreader-large-jsonl
test-requirements: [unit, typecheck, lint]
runtime-targets: [macos, linux]
impacts: [config-schema]
attempts: 0
last-test-result: pass
implementation-commits: [2ea7fa1, d3c04b1, b8abda2, 9a6f1ec, 5a62cfb, 777f6af, 4578e14, dfb97c7]
external-refs: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-08

**DONE (2026-07-08):** per-account cost-aware 5h/7d window budget + account/plan awareness + statusline $/hr artifact fix + per-account dashboard display all shipped & gate-green.

**WHY THIS EXISTS:** User burned a full 5h account window "in a breath" (had to rotate to a second
email/account). Asked: *what is actually consuming all those tokens?* — and demanded AgentLens surface,
per account: current account, plan type, % of 5h window left, % of 7d window left. This TRDD holds the
whole investigation + the multi-part feature. Captured to wikimem + this TRDD so it survives compaction
(user: "don't forget the plans, use the wikimem").

### THE INVESTIGATION FINDING (verified, definitive — DONE)
- **96% of every "consumed token" is `cache_read`** — the resident context (huge CLAUDE.md + ~20
  `~/.claude/rules/*` + MCP tool schemas [lean-ctx ~100 tools, codegraph, chrome-devtools] + accumulated
  marathon transcript) re-read on EVERY turn. Fresh input ~0.1%, output ~0.2%.
- Mechanism: `src/burnMonitor.ts` sums all 4 buckets (`input+output+cache_read+cache_create`) for both
  the burn RATE and the 5h/7d window "consumed" total. So the alarming raw numbers are ~96% cheap
  cache-reads (cache-read is billed 0.1× input).
- Live proof (4 concurrent sessions, cumulative): 1.66B total, cache-read 1.60B (96.2%). ANIME2SVG alone
  884M over 2164 turns ≈ 408k tok/turn re-read. No double-counting (deduped by Anthropic message.id).
- Root cause of the burn = **resident-context floor (~300-400k/turn) × marathon turn count × N
  concurrent sessions**. Levers: shrink CLAUDE.md+rules+MCP surface; fewer concurrent marathons; start
  fresh sessions.

### COST-vs-TOKEN (user's key correction — ANSWERED)
- User: if the window limit is COST-based, cache-read (0.1×) should barely matter.
- Real math: even cost-weighted, cache-read is ~70% of the 5h window's billable weight — its VOLUME
  (220M) is so large that 220M×0.1 = 22M dominates output(0.3M×5) + cache-create(5.9M×1.25). So it
  dominates BOTH raw count AND cost. Per-token cheap, but the volume wins.
- Raw 5h = 227M tokens; cost-weighted = 31M input-equivalents (7.3× smaller); actual **cost $897 (5h),
  $14,520 (7d)** — but these POOL all accounts + all sessions machine-wide (see per-account, below).

### DONE (committed this session)
- `2ea7fa1` — burn RATE + window budget carry a per-bucket `breakdown` {input,output,cacheRead,
  cacheCreate,unknown} + `billableWeightedPerMin` / `consumedBillableWeighted` (cost in fresh-input-token
  equivalents; weights `BILLABLE_WEIGHTS` = output 5×, cacheRead 0.1×, cacheCreate 1.25×). 351 tests pass.
- `d3c04b1` — threaded the per-bucket split through the STATUSLINE event path (was 100% `unknown` for
  no-OTEL sessions = the live case); split on PRESENCE of buckets not source; webview `BurnBreakdownBar`
  in the Realtime burn monitor (Alerts config section) + window line shows cost + billable-weighted.
  Verified live: cache-read ~99% of count, billable-weighted 152k vs 1.41M raw (9.3×), 0 errors.
- Also this session (adjacent perf fixes): `309d077` Cache-tab O(n²) fleet tree; `bd8c94d` Analytics/Flow
  render-body eager-fetch → useEffect+peek; `73873e2` ContextTab O(n²) sub-agent tree.

### NEXT ACTIONS (pending — the account/window feature; NOT yet built)
1. **PER-ACCOUNT window budgeting (highest priority).** Rate limits are per OAuth account, not
   machine-wide. Rotating mid-window must NOT pool consumption. Steps:
   - Identify each session's account. OAuth token is in the **macOS keychain** (`security
     find-generic-password` — Claude Code's credential). Need a stable account key (email / org id /
     token fingerprint) recorded PER SESSION at ingest time so historical sessions attribute correctly.
     Investigate where CC records account/org in the session jsonl or statusline (`rec.*`), else derive
     from the active keychain token at scan time (only correct for live sessions — historical need a
     recorded field).
   - `computeWindowBudget` must GROUP events by account and sum within account → per-account 5h/7d.
2. **Cost-based window option.** Let capacity be configured in COST ($) OR tokens; compute `pctConsumed`
   on `consumedCostUsd`/cost-cap when cost-based (cache-read barely counts), on raw tokens otherwise.
   Config: add `window5hCostUsd`/`window7dCostUsd` alongside the token caps.
3. **Empirical capacity auto-calibration.** Capacity = consumption at the moment a window ends
   **PREMATURELY** (a rate-limit/usage-limit hit — user always waits for exhaustion), NOT a time-based
   5h rollover (that measures elapsed time, not the cap). Detect the premature-end signal (rate-limit
   error in the session log / account rotation / a "limit reached" marker), snapshot consumed
   (tokens+cost+billable-weighted) since that account's window start → that's the observed cap for that
   account/plan. Removes the need to hardcode Anthropic's undisclosed caps.
4. **Account + plan awareness (surface).** Show, per current account: identity (email/label), plan TYPE
   — subscription (oauth; window-limited; flat-rate) vs API pay-per-token vs subscription-token-usage
   mode (user opts into token billing after the window hits) — and % 5h / % 7d remaining.
5. Wire it all into `/api/burn-status` + SSE + `get_burn_status`/`get_session_status` MCP + the webview
   burn monitor.

### LOAD-BEARING FACTS / GOTCHAS
- Burn events have 2 sources: OTEL `api_request` (rich, per-bucket + attribution) and statusline billing
  deltas (KT87QPM0). Live no-OTEL sessions use statusline — MUST carry buckets there (done).
- Statusline `rec.input_tokens` etc. are FRESH/uncached per-turn buckets (separate from
  cache_read_input_tokens); their sum == deltaTokens. No overlap/double-count.
- `BILLABLE_WEIGHTS` ratios are model-INDEPENDENT (output 5× input, cache-read 0.1×, cache-write 1.25×
  hold for Sonnet 3/15 and Opus 15/75) — safe to hardcode; they are NOT Anthropic's rate-limit-window
  weighting (undisclosed).
- `capacityConfigured:false` today → no %/projection. env `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` or
  `~/.agentlens/burn-config.json`.
- Server is supervised (`scripts/agentlens-supervise.js`); SIGTERM the child → graceful flush → auto
  respawn with fresh build. Burn tick pushes SSE every 4s.
- SECURITY (standing): commits LOCAL only, NEVER push (origin=upstream RogerReed/agentlens). Stage by
  name. Test headless dev-browser only. Never touch real `~/.claude/settings.json`; config writes via
  `safeConfigEdit`.

### DURABLE ARTIFACTS TO READ BEFORE ACTING
- `.claude/project/memory/agentlens-burn-token-model.md` — the wikimem page (symptom-indexed).
- `src/burnMonitor.ts` (the model), `src/statuslineUsage.ts` (statusline event source).
- `reports/mcp/P4-mcp-surface-spec.md` — the broader MCP surface plan.

## Body

This TRDD converts the live token-burn incident (a 5h account window drained in minutes, forcing an
account rotation) into a durable investigation record + a scoped feature: make AgentLens's window budget
**per-account, cost-aware, and self-calibrating**, and surface account + plan awareness. See the STATE
block above for the authoritative current state and the ordered next actions.
