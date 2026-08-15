---
trdd-id: 1UTH3B3V
title: Per-model headroom rotation query on get_account_status --all
column: complete
created: 2026-08-15T16:50:00+0200
updated: 2026-08-15T17:05:00+0200
current-owner: agentlenspro-main-session
task-type: feature
approval-tier: 0
relevant-rules: []
implementation-commits: [6ff38e1]
---

# Per-model headroom rotation query (USER-ordered 2026-08-15)

USER (verbatim intent): the janitor's rotator cannot ask the CLI which account still has
headroom for **Fable** (or any model with its own usage window). It must rotate as soon as the
Fable window is spent, to an account whose Fable window still has headroom; if NO registered
account has headroom, the CLI must SAY that, and the rotator then switches model and asks for
the accounts whose 5h AND 7d windows are both not used up. JSON output for scripts. Backward
compatible.

## Design

All data already exists: `SubscriptionUsage.limits` carries `weekly_scoped` buckets with
`scopeLabel` = the model display name (e.g. "Fable"), and `allAccounts.ts` has the
freshness/bound machinery. Additive changes only:

1. `AccountStatusRow.modelWindows: ({ model } & AccountWindow)[]` — each `weekly_scoped`
   bucket classified through `classifyWindow` (same fetchedAt/leftAt/labelSuspect). The
   verbatim `scopedWeekly` stays (backward compat).
2. `selectAccountsWithHeadroom(answer, { model?, threshold=100 })` — pure, per-account gates
   over fiveHour + sevenDay (+ the model bucket when `model` given):
   - gate percent ≥ threshold ⇒ EXHAUSTED (safe on exact AND lower bounds);
   - gate percent null ⇒ UNDECIDABLE (never conflated with exhausted);
   - `--model X` with no scoped bucket for X in the reading ⇒ UNDECIDABLE with reason;
   - verdict: `available` | `none-with-headroom` (every account POSITIVELY exhausted) |
     `indeterminate` (no match but ≥1 undecidable — never claim "none" on unknowns);
   - matches carry `confidence`: measured > inferred (rolled, audit leftAt) > lowerBound.
3. CLI flags on `get_account_status --all`: `--model NAME` (case-insensitive substring on
   scopeLabel), `--with-headroom`, `--threshold N` (1..100, default 100 = "not used up").
   Human output: verdict line (explicit `NO ACCOUNT HAS HEADROOM…` when so) + match table.
   `--json`: full existing answer + additive `selection` block. Exit codes unchanged
   (0 answered — including "none", which IS an answer; 2 BLIND; 64 usage).
4. MCP `get_account_status all:true` inherits `modelWindows` for free via the shared row.

## Acceptance

- [x] modelWindows classified on every row with a usage reading
- [x] --model fable → matches / exhausted / undecidable partition, honest verdict
- [x] verdict none-with-headroom ONLY when every account is positively exhausted
- [x] --with-headroom (5h+7d both < threshold) works without --model
- [x] --json additive: prior consumers of --all --json see unchanged fields (verified live: selection block + all prior fields)
- [x] unit tests for selection semantics + CLI flags (9 added, suite green); tsc + eslint + mirrors + identities clean (compile exit 0)
- [x] version 2.26.0 + CHANGELOG entry
- [x] verified through the BARE `agentlenspro` command on the real 3-account roster (verdict available; one spent-on-Fable exclusion; one undecidable) and via --json (selection.verdict/liveAccountId parse clean); server restarted so the MCP tool serves the enriched rows

## Approval log
