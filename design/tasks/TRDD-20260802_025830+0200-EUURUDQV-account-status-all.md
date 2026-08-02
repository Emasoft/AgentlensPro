---
trdd-id: EUURUDQV
title: get_account_status --all — every observed account, honestly stamped
column: ai_review
created: 2026-08-02T02:58:30+0200
updated: 2026-08-02T04:20:00+0200
current-owner: unassigned
task-type: feature
npt: []
eht: []
---

# `get_account_status --all` — every observed account, honestly stamped

Implements GitHub issue **#8** (filed by ai-maestro). Design agreed in
[issue #8 comment](https://github.com/Emasoft/AgentlensPro/issues/8#issuecomment-5154303297).
Evidence: `reports/account-status-corpus/20260802_025650+0200-multi-account-status-corpus-scan.md`.

## Why

ai-maestro's OAuth rotator faces a bootstrap paradox: deciding whether to rotate needs the headroom of
the accounts that are NOT live, and today the only way to learn an account's status is to already be on
it. Measured cost on this host: three accounts, two holding refresh tokens that had died days earlier,
the rotator correctly refusing to move onto a credential it could not validate — and the whole host
stalled at the limit while one of those accounts had a nearly empty window the entire time.

## The constraint that shapes everything

**The OAuth token is never read or returned.** An 80-project corpus scan found the direct answer is
unanimous and unavailable to us: every multi-account tool holds a credential per account and calls the
usage endpoint N times. So this feature reports each account **as last observed, stamped** — never by
acquiring a credential.

## Phase 1 — key the usage cache by account (do this FIRST, alone) — ✅ DONE

`~/.agentlens/subscription-usage.json` is a single file, overwritten on every fetch, so every rotation
destroys the previous account's last true reading.

Small, and **time-sensitive**: it accumulates from the day it ships and cannot be backfilled. Landing it
before Phase 2 is the difference between `--all` having history on day one and having one row.

- [x] Per-account archive at `~/.agentlens/subscription-usage/<accountUuid>.json`, atomic
      write-then-rename, **additive** — the live cache keeps its exact TTL/cooldown/lock behaviour and
      every existing consumer is untouched. This only stops us throwing away what was already fetched.
- [x] **KEYED BY `accountUuid`, NOT `accountFp`** — this corrects the shape proposed in the issue
      comment. `fingerprint()` derives from the REFRESH token, which Anthropic rotates server-side, so
      the fp changes without an account switch; keying files on it would scatter one account across a
      pile of orphaned files. The fp stays INSIDE the record as the cache-validity key it already is.
      Found by reading `fingerprint()`'s own doc comment, which says exactly this.
- [x] A uuid arriving from the network is refused unless it is uuid-shaped, never sanitized — it
      becomes a path segment. The first version of that test was **vacuous** (it asserted the wrong
      location, so an escaped write landed outside the sandbox and the test passed with the guard
      removed); the data dir is now nested inside the sandbox so an escape is visible.
- [x] Legacy single file adopted, but only when NEWER than what is already archived — otherwise a
      stale legacy file walks a fresher record backwards on every call.
- [x] An unidentified reading is NOT filed under a made-up key, and one unreadable record costs one
      account rather than the whole listing.
- [x] Adoption runs at server start and on the hourly maintenance timer — deliberately NOT on the read
      path, which the status line hits every render.
- [x] 7 tests, each verified to fail against its own broken version (fp-keying: 4 fail; no path guard:
      1; unconditional adoption: 1; abort-on-bad-record: 1).
- [ ] Retention: these are small and their whole value is age. Do not purge on the hook-event schedule.
      **Still open** — nothing purges them today, which is correct for now but undecided.

Landed and deployed: archive materialized on restart with the live account's reading preserved.

## Phase 2 — the plural verb — ✅ DONE

Roster (`account-state.ndjson` — the ONLY source that knows an account exists) × per-account cache.

- [x] `accounts[]` with `isLive`, `observedAt`, `staleSeconds`, `leftAt` and `freshness`; plus
      `liveAccountId` and `blind`. `src/allAccounts.ts`, wired to `get_account_status --all` (MCP) and
      to a CLI fast path that **bypasses the server** — the description already claimed "works with the
      server cold" and the first build did not: stopping the server returned `cannot reach
      http://localhost:4316/mcp`, the one answer useless to a rotator. Fixed, not reworded.
- [x] **`freshness` is per WINDOW, not per account** — the 5h and 7d roll at wildly different rates, so
      a day-old reading gives a known-empty 5h and a merely-aged 7d and one label cannot say both. Five
      values (an `aged` was added: past the TTL but not reset, so the number survives as a LOWER bound
      rather than being discarded):

  | verdict | meaning |
  |---|---|
  | `fresh` | read within TTL |
  | `rolled` | the observation's window passed `resetsAt` AND no activity observed on this account since ⇒ ~0% |
  | `stale` | expired, activity since cannot be excluded ⇒ `null` **with a reason** |
  | `unreadable` | roster knows the account, no usable observation ⇒ `null` **with a reason** |

- [x] `rolled` prints its **precondition in the payload** ("no activity observed by THIS machine"). It
      is an inference, and the same account used from another host breaks it. A consumer must be able to
      tell an inference from a measurement; a rotator that cannot is the failure this doctrine exists to
      prevent.
- [x] `unreadable` is never an absent row. The outage above is exactly "not exhausted, unreadable", and
      a missing row renders identically to an account with no headroom.
- [x] Per-account `mode`; every null carries a reason and `0` is never a stand-in for unknown.
- [x] Per-model weekly buckets reported but NOT folded into the verdict.

**Two corrections it took to get `rolled` right, both worth keeping:**

1. The comparison is `leftAt` vs the **RESET INSTANT**, not vs the reading. Against `fetchedAt` it
   reads plausibly and never fires — a reading is normally taken WHILE the account is live, so the
   machine always leaves after it. Caught by a test that expected `rolled` and got `stale`: the
   fixture was right and the condition was wrong.
2. A **suspect account label disables the inference entirely**. `leftAt` derives from the timeline's
   accountId, which comes from `~/.claude.json` — so when the reading's own account contradicts that
   claim, "this machine left the account" is unfounded. Not hypothetical: on this host the config says
   fmuaddib while the keychain credential belongs to ipazia, so every reading on record is ipazia's.

16 tests; six mutations each verified to fail (wrong reset instant 4, stale returning 0 4, no suspect
guard 1, omitting unreadable accounts 2, live account inheriting a stale leftAt 1, verdict taking the
better window 1).

## Phase 3 — payload normalization the corpus measured against the live endpoint — ✅ DONE

- [x] `windowPct()` accepts `utilization` **or** `used_percentage`.
- [x] `normalizeResetsAt()` accepts unix **seconds or ms**, as a **number or numeric string**, or
      **RFC3339** (kept verbatim). The `< 1e12 ⇒ seconds` threshold is ccbroker's.
      **This was not cosmetic**: we accepted only the string form, so a numeric epoch became `null` —
      and a null `resetsAt` silently disables BOTH the already-reset check in `deriveStale()` and the
      `rolled` verdict, serving a window that no longer exists as if it were current. That is the same
      failure `deriveStale`'s own comment was written after (a weekly window that rolled on 07-28 still
      being reported as a current 96% four days later).
- [x] **A third bug, found while in there:** `percent: num(l.percent) ?? 0` turned an unparseable
      percentage into **0** — "this window is empty", the most dangerous substitution available, since
      every consumer reads it as all the headroom in the world. `UsageLimit.percent` is now
      `number | null`; the formatter prints `?` and `[unreadable]` rather than an empty bar, and the
      two computing consumers already skipped nulls.
- [x] Model-scoped weekly buckets are kept out of the account verdict (done in phase 2; `budget`'s
      `officialBuckets` already reports them by model name, which was already correct).
- [x] 4 tests, each verified to fail against its own broken version (single spelling, string-only
      resets_at, `?? 0`, seconds-as-ms).

## Verification

- [x] Regression tests verified to fail against the unfixed version — 20 tests across the three
      phases, 14 mutations each confirmed to be caught.
- [x] A real sample posted to issue #8 for ai-maestro to test the rotator against before the shape is
      frozen.
- [ ] **AWAITING ai-maestro's response on the payload shape.** That is the only thing left; the shape
      is deliberately not frozen until the rotator has run against it.

## Still open

- [ ] Retention for the per-account archive. Nothing purges it today, which is correct for now
      (records are ~1 KB and their whole value is age) but undecided.
- [ ] The `has_extra_usage_enabled` lead below.

## Open lead, not a confirmed bug

`sentinel-main-2` warns that `organization.has_extra_usage_enabled` is org-level and true for any team
org with Max members, so it cannot identify whether THIS user has a Max seat — it uses
`account.has_claude_max` instead. We read `hasExtraUsageEnabled` from `~/.claude.json`'s `oauthAccount`
(`src/accountInfo.ts:68`), i.e. Claude Code's own flattened copy, so the warning may not apply. It
matters because `src/ttlContext.ts:60` uses that flag to pick the cache-TTL regime — a 2× cost
difference. **Verify on a team-org seat; do not "fix" it on the strength of another project's comment.**
