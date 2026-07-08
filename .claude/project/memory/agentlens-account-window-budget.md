---
name: agentlens-account-window-budget
description: "window budget mixes multiple accounts after rotation / rate limit is per account not machine-wide / how does AgentLens know which oauth account / % of 5h and 7d window remaining per account / plan type subscription vs api token / empirical window capacity calibration"
ocd: 2026-07-08
lmd: 2026-07-08
metadata:
  node_type: memory
  tier: component
  type: project
  globs: ["src/burnMonitor.ts"]
---

# AgentLens per-account window budget + account/plan awareness (planned)

**Requirement (from the burn incident):** AgentLens must track the token window budget **per OAuth
account**, and surface — for the CURRENTLY active account — its identity, plan type, and % of the 5h +
7d windows remaining. Governed by [[agentlens-burn-token-model]]; tracked in TRDD-BURNWDGT.

**The core correctness bug:** `computeWindowBudget` sums consumption **machine-wide across all sessions
and all accounts**. Rate limits are **per account** (each account = one OAuth token, on macOS stored in
the **keychain**). The user always waits for a window to exhaust, then rotates to a second account
(second email/Max subscription — legitimate personal automation). Sometimes the **7d** window exhausts
before the **5h**. Consumption after rotation belongs to a DIFFERENT account and must NOT be pooled with
the previous account's window.

**What's needed (ordered):**
1. **Per-session account identity, recorded at ingest.** Find where Claude Code records account/org/email
   (session jsonl fields? statusline `rec.*`?); else derive from the active keychain OAuth token at scan
   time (only valid for LIVE sessions — historical need a stored field). Then group window events by
   account key.
2. **Cost-based window option.** Capacity configurable in $ OR tokens; `pctConsumed` on cost when the
   plan is cost-based (cache-read barely counts) vs raw tokens otherwise. Add `window5hCostUsd`/
   `window7dCostUsd` config beside the token caps.
3. **Empirical capacity auto-calibration.** The observed cap = consumption at a **PREMATURE** window end
   (a rate-limit / usage-limit hit), NOT a time-based 5h rollover (that measures elapsed time, not the
   cap). Detect the premature-end signal (rate-limit error in the log / account rotation / limit marker),
   snapshot consumed tokens+cost+billable-weighted since that account's window start → that's the plan's
   real cap. Avoids hardcoding Anthropic's undisclosed limits.
4. **Plan-type awareness.** subscription (oauth; window-limited; flat-rate) vs API pay-per-token vs
   subscription-token-usage mode (user opts into token billing after the window hits).

**Not yet implemented** — this page is the spec; the burn breakdown groundwork (per-bucket + cost-weighted)
already shipped (commits 2ea7fa1, d3c04b1). See TRDD-BURNWDGT STATE block for the live next-actions.

## Notes and lessons learned
