# agentlenspro-diagnostics — The per-call ledger, window usage, every account

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## The per-call ledger — `get_cache_event_log`

Answers "**did that compaction / command / turn burn tokens on a cache miss?**" in ONE call. One row
per API call with every bucket spelled out (input, cache write, cache read, output), the write's TTL
tier, its cost-weighted size in **input-equivalent tokens**, and the exact USD.

```bash
agentlenspro get_cache_event_log                        # peak + the 3 calls before/after (default)
agentlenspro get_cache_event_log --mode recent --limit 20
agentlenspro get_cache_event_log --window 4 --context 5 --format markdown
agentlenspro get_cache_event_log --project <path-or-slug>   # another project (default: the cwd's)
```

- **`mode=peak`** centres the **costliest** call and shows the calls around it — a cold write is only
  interpretable next to the warm turns beside it (137k reads as a disaster alone, and as a cheap
  one-off next to the 613k prefix it replaced). **`mode=recent`** lists the last N regardless of cost.
- **🔥×1-5 by ORDER OF MAGNITUDE** (1+ / 10k+ / 50k+ / 150k+ / 400k+), because on a linear scale a
  400k full-prefix rewrite and a 12k suffix write both just look "big".
- **Scoped to ONE project as a hard boundary**, not a filter: this machine interleaves many concurrent
  sessions from unrelated repos into one bodies directory, so rows appear only for sessions the
  project provably owns. Exclusions are reported split into `otherProject` (the boundary working) and
  `unattributable` (a real coverage gap) — one merged number would hide the gap behind the guarantee.
- **Reads the OTEL span store first.** Those `api_request` events carry `session.id` directly, so
  attribution is exact and even a compaction's own summarization call appears (`query_source:
  compact`) — the raw-body fallback's `previous_message_id` chain cannot attribute it, nor a
  session's newest call. The `cache miss reason` column is the **API's own verdict**
  (`system_changed` / `tools_changed` / `messages_changed` / …) from the cache-diagnosis beta, not a
  statistical inference.

## Authoritative window usage — `get_subscription_usage`

The **real** 5h/7d utilization — Anthropic's own numbers, the same ones `/usage` renders. Every other
window tool here INFERS the cap from observed rate-limit hits (`capacitySource: observed |
same-plan-proxy | none`, and no ETA when uncalibrated); this reads the actual percentage.

```bash
agentlenspro get_subscription_usage             # cached ≤10 min
agentlenspro get_subscription_usage --force     # deliberate refresh (still respects a 429 back-off)
```

Returns the generic **`limits[]`** array — `{kind, group, percent, severity, resetsAt, isActive,
scopeLabel}`, kinds `session` / `weekly_all` / `weekly_scoped` (per-model) — rather than only the two
named windows, because the payload carries buckets that named-field parsing silently drops. Also
`usageCreditsEnabled`, the **live cache-TTL oracle** (see the TTL section above).

**Operational notes.** The endpoint is undocumented, community-reverse-engineered (technique credit:
`pizzimenti/ccgauge`), and **429s hard — knocking again RE-ARMS the lockout** rather than queueing.
Hence a 10-minute cache, `Retry-After` honored, exponential back-off on *consecutive* 429s, and a
cross-process lock. **Never poll it in a loop; use `--force` only for a deliberate one-off.** Failures
degrade to the last reading with an explicit `reason` (`cooldown` / `no_token` / `opt_in_required` /
`lock_contended` / `http_error`), and a stale reading **suppresses its countdowns** rather than
rendering an already-rolled window as live. On macOS the token is in the login keychain, so the read
is **opt-in**: export `AGENTLENS_READ_KEYCHAIN_USAGE=1` (an un-ACL'd keychain read pops a password
prompt, which is unacceptable from a status line or hook).

## Every account, not just the live one — `get_account_status --all`

`get_account_status` answers for the account you are on **right now**. That is the wrong shape for a
rotator: deciding whether to switch needs the headroom of the accounts you are **not** on, and the only
way to learn an account's status used to be to already be on it. **You had to rotate to find out
whether you should rotate.**

```bash
agentlenspro get_account_status --all          # a table; '*' marks the live account
agentlenspro get_account_status --all --json   # every field, including the reason behind every null
```

```
   account   email               plan     5h window   7d window   observed  left
*  bbbbbbbb  owner@example.com   Max 20x  unreadable  unreadable  never     (on it)
   aaaaaaaa  second@example.com  Max 20x  0% rolled   77% aged    352m ago  07-31 15:28
   cccccccc  third@example.com   Max 20x  unreadable  unreadable  never     07-30 17:19
```

**No credential is read** — the OAuth token contract is unchanged. Every row is what was already
observed while that account was live, stamped. It is assembled entirely from files, so it **answers
with the server down**, which is exactly when a wedged machine is asking.

**The verdict is per WINDOW, not per account**, because the 5h and 7d roll at wildly different rates:

| freshness | meaning | number |
|---|---|---|
| `fresh` | measured inside the cache TTL | the percentage |
| `aged` | past the TTL, but the window has **not** reset — utilization only grows | a **LOWER bound** |
| `rolled` | the window reset **and** this machine was already off the account when the new one began | **INFERRED ~0%** |
| `stale` | reset, but activity since cannot be excluded | `null` + a reason |
| `unreadable` | never observed | `null` + a reason |

`rolled` is the one that pays for the feature: an account at 91% whose 5h window has since reset, that
nothing local can have filled, is **available** — not unknown. It is an **inference**, it says so, and
its precondition ("no activity observed **by this machine**") travels in the payload — audit it with
the `left` column before acting. It is deliberately suppressed when the reading's own account
contradicts `~/.claude.json`, because the premise then rests on a claim known to be wrong.

**`unreadable` is never an absent row.** "Cannot read this account" and "this account has no headroom"
are opposite signals; a missing row renders as the second. An empty roster is **BLIND** (exit 2 —
the house "cannot answer honestly" code; it was 1 before v2.22.0), never "no accounts". Per-model weekly buckets are reported separately and **never** folded into the
verdict — a spent per-model bucket does not block other models.

