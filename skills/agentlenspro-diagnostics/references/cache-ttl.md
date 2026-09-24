# agentlenspro-diagnostics — Cache TTL tracking

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Cache TTL tracking — a warm gap is NOT a cold rewrite (TRDD-VY1IUVUM)

The prompt-cache TTL is **not a universal 5 minutes** — a subscription MAIN session rides a **1-hour**
tier, so a 20-min gap on it is still WARM. Hardcoding 5 min made the gate/keepWarm cry "cold rewrite"
on sessions that never went cold. Every TTL number now carries a `ttlSource` so you can trust or
question it. The doc-verified matrix (`src/shared/cacheTtl.ts` — the ONE place these numbers live):

| Session kind | Auth | TTL |
|---|---|---|
| Main conversation | subscription (within plan) | **1 hour** (automatic) |
| Main conversation | subscription drawing USAGE CREDITS (over plan) | **5 min** (auto-dropped) |
| Main conversation | API key / Bedrock / GCP / Foundry | **5 min** (`ENABLE_PROMPT_CACHING_1H=1` → 1h) |
| Subagent (named/general) | any | **5 min ALWAYS** (own conversation, own cache) |
| Fork | inherits parent | reads the PARENT's entry; every hit RESETS its timer |

`FORCE_PROMPT_CACHING_5M=1` forces 5 min regardless of auth. Every cache hit resets the timer; cron
fires are main-conversation turns (they renew it).

**The TTL also sets the WRITE PRICE — the tier is not cosmetic.** A 5-minute cache write bills at
**1.25×** base input; a **1-hour write at 2×**. Since a subscription MAIN session takes the 1h tier
automatically, most writes on such a machine cost 2×, and pricing them at the 5m rate under-reports
by 60%. Verified against Claude Code's OWN `cost_usd` (2026-07-26): solving the implied rate over
~700 opus calls gives a median of exactly $10.00/MTok with a p10 of exactly $6.25 — both tiers occur,
so neither flat rate is right — and joined to their raw bodies the implied rate matches the body's
`usage.cache_creation.ephemeral_{5m,1h}` tier 26/26. **Prefer a harness-reported `cost_usd` over any
local recomputation**: Claude Code's own price table is tier-aware. `get_cache_event_log` labels each
row's `costSource` (`harness` vs `computed`) so you can see which you are reading.

**Which tier am I on right now?** `agentlenspro get_subscription_usage` reports
`usageCreditsEnabled` — credits OFF means the automatic 1-hour TTL is active (2× writes); credits ON
means it dropped to 5 minutes (1.25×). That is a live reading, not an inference from auth signals.

**Reading the TTL-aware output.** `get_account_status.cacheTtl` = `{minutes, regime, ttlSource, basis}`
for your MAIN session; keepWarm/gap classifications carry `ttlAssumedMin` + `ttlSource`:
- `doc-matrix` — a matrix row applied to positively-resolved signals (trust it).
- `config` — an env override (`FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H`) decided it.
- `measured` — observed cache behaviour CONTRADICTED the assumption (a cache hit after the assumed
  expiry) and the measured floor was preferred. keepWarm's falsifier flips the source to this.
- `assumed` — a signal was absent, so the conservative 5-min floor was reported AS an assumption
  (never a silent guess).

**True cold rewrite vs normal suffix write.** A small per-turn `cache_creation` is NORMAL incremental
suffix writing. Only a **full-prefix-sized** creation spike is a real cold rewrite. Invalidation causes
≠ TTL expiry: model/effort/fast-mode switch, MCP connect/disconnect, bare-tool deny, compaction, CC
upgrade. Use `get_cache_break_gap_report` to separate TTL-expiry from a real prefix change, and
`trace_expensive_writes` for the biggest single writes + their contents.

**Zero cache activity is its OWN answer, not a quiet timeline.** When a turn reports
`cache_read: 0` AND `cache_creation: 0`, nothing was cached — and `get_cache_break_causes` /
`get_cache_break_timeline` name why instead of dropping the turn under the cache_creation floor:
`CACHING_DISABLED` when the request carried no `cache_control` marker at all (a
`DISABLE_PROMPT_CACHING*` env var — or a caller that deliberately does not cache a class of calls,
like Claude Code's small Haiku utility calls), and `BELOW_MIN_CACHEABLE` when markers WERE present
but the prompt is under that model's minimum cacheable length (512 → 4,096 tokens depending on the
model — an 8× spread, so never reason from one model's threshold). Both fail SILENTLY at the API:
no error, just full input rate on every call. A third, `LOOKBACK_OVERFLOW`, covers the opposite
shape — an unchanged prefix that still read nothing because ≥20 blocks were appended since the last
write and the 20-block lookback window walked past the entry.

**Two request parameters change the prefix without changing a byte of content**, and the classifier
reports them as `THINKING_CONFIG_CHANGED` / `EFFORT_PARAM_CHANGED` / `TOOL_CHOICE_CHANGED`. It names
them **only between two different EXPLICIT values**: setting a parameter explicitly to the model
default is a documented no-op, the per-model defaults are not published, so an absent→explicit
transition is undecidable and is left unnamed rather than guessed. `WORKING_DIR_CHANGED` and
`GIT_STATE_CHANGED` are the same idea one layer up — the environment block and the startup git
snapshot ride inside the cached system prompt, which is why a second worktree of one repo never
shares a cache and why two sessions share a prefix only when their startup git snapshot matches.

**One-liner recipes.**
```bash
agentlenspro get_account_status                      # your session's cacheTtl regime + windowSource
agentlenspro get_cache_break_gap_report              # TTL-expiry vs real prefix change, per gap
agentlenspro get_cache_break_causes                  # what breaks the cache machine-wide
agentlenspro cache-expired                           # → the WORD 'true' or 'false' (this project)
agentlenspro cache-expired -q                        # → nothing; exit 0 = EXPIRED, 1 = fresh
agentlenspro cache-state                             # → the WORD 'warm' or 'cold'; exit 0 = warm, 1 = cold, 2 = cannot answer
agentlenspro cache-state --json                      # → the stored prompt_cache_* fields verbatim + state/session_id/captured_at
agentlenspro last-compact                            # → how long ago this project compacted ("2h 14m")
agentlenspro last-compact --seconds                  # → a bare integer for arithmetic
agentlenspro check_cache_expiry                      # the full verdict object (this project's main)
agentlenspro check_cache_expiry --all                # every session's fresh/expired verdict
agentlenspro check_cache_expiry --thresholdMinutes 60 --out /tmp/exp.json   # probe "> 1h idle"
```

**Want a plain true/false? Use `cache-expired`, not the tool.** The tool returns a verdict OBJECT and
exits 0 either way, so a script has to parse JSON and cannot branch on `$?`. The verb is the same
verdict in a shape a shell consumes:

```bash
if agentlenspro cache-expired -q; then echo "cold — the next turn re-writes the whole prefix"; fi
[ "$(agentlenspro cache-expired)" = true ] && do_something     # the value form
```

- **stdout is exactly one word** (`true` = expired, `false` = fresh); which session was measured goes
  to **stderr**, so a pipe stays parse-safe and a wrong-repo answer can never look like a right one.
- **exit**: default `0` = answered · `2` = cannot answer (stdout **empty**) · `64` = bad flags.
  With `-q`: `0` = EXPIRED · `1` = fresh · `2` = cannot answer.
- **It never prints `false` for a question it could not resolve.** No LLM call recorded, no session in
  scope, or the server unreachable → exit 2 with the reason on stderr, because "warm" and "I cannot
  tell" lead to opposite decisions. A transport failure exits **2, never 1** — under `-q`, 1 means fresh.
- Flags: `--project DIR` (default: the current directory) · `--session ID` · `--threshold-minutes N`
  · `--json` (the full object plus a top-level `expired` boolean).

**How long ago did this project compact? `last-compact`.** A compaction rewrites the whole prefix at
the write rate, so "when did it last happen" is a cost question, and the answer is a **delta** — the
form the decision actually needs:

```bash
agentlenspro last-compact                  # stdout: "2h 14m"   stderr: which compaction (trigger, session)
age=$(agentlenspro last-compact --seconds) && [ "$age" -lt 300 ] && echo "compacted just now"
```

- **Manual `/compact` AND auto-compact both count** — they cost the identical rewrite. The newest of
  either wins and the stderr line names which (`manual compact at …` / `auto compact at …`);
  `--trigger manual|auto` narrows it.
- Sourced from the **PreCompact lifecycle hook** (the compaction itself, with its trigger), read
  straight off the hook-event store — so it **answers with the server down**. It needs
  `agentlenspro --install-hooks`; with capture never installed the store is empty and the command
  says exactly that.
- **exit**: `0` = answered · `2` = no compaction on record (stdout **EMPTY**) · `64` = bad flags.
  A never-compacted project prints **nothing**, never `0` — "no compaction" and "compacted 0s ago"
  are opposite claims, and `age=$(… --seconds)` must not hand a script a number it would read as
  "just now".
- Flags: `--project DIR` (default: current directory; `''` = any project) · `--session ID` ·
  `--trigger manual|auto` · `--window-days N` (default 31, the store's retention) · `--json` (adds
  the ISO stamps, the matching PostCompact completion and how long the compaction took).
- Scope is path-boundary aware and symlink-tolerant: a worktree under the root counts, a sibling
  `<root>-old` does not, and a `cwd` recorded through a symlink (macOS `/var` → `/private/var`) still
  matches its resolved root.

**Scoping (changed 2026-08-04, and it was a real defect):** both this verb and `check_cache_expiry`
now default to **the calling project's** newest main session. The old default picked the newest main
session machine-wide — measured, a probe run inside one repo answered about a session in an unrelated
one with nothing in the payload disclosing it. Pass `--project ''` to `check_cache_expiry` for the old
machine-wide pick; `--all` still spans every project unless you scope it.

**Is a specific claude's cache expired yet?** `check_cache_expiry` answers exactly "has more than
the TTL passed since this session's last LLM request?" — idle since the last `api_request`, compared
to that session's TTL (1h subscription-main, 5min subagent/usage-credits), so `expired` means the
prefix was likely evicted and the next request pays a full cache-creation write. Per session it
returns `verdict` (fresh|expired|unknown), `idleHuman` ("1h 12m"), `ttlMin`+`ttlSource`+`ttlBasis`
(same honesty contract — unknown auth → an `assumed` 5-min floor, never a silent guess), and
`lastRequestAt`. Default = the newest MAIN session; `--all` = every session; `--sessionId <id>` = one;
`--thresholdMinutes N` overrides the TTL with an explicit cutoff (e.g. `60` to probe "more than 1h").
A `verdict:"unknown"` means no LLM request was recorded for that session.

