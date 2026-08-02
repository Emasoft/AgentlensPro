---
trdd-id: EUURUDQV
title: get_account_status --all — every observed account, honestly stamped
column: todo
created: 2026-08-02T02:58:30+0200
updated: 2026-08-02T03:10:00+0200
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

## Phase 2 — the plural verb

Roster (`account-state.ndjson` — the ONLY source that knows an account exists) × per-account cache.

- [ ] `accounts[]` with the existing single-account shape plus `isLive`, `observedAt`, `staleSeconds`,
      and `freshness`; plus `liveAccountId`.
- [ ] **`freshness` is the load-bearing field**, four values:

  | verdict | meaning |
  |---|---|
  | `fresh` | read within TTL |
  | `rolled` | the observation's window passed `resetsAt` AND no activity observed on this account since ⇒ ~0% |
  | `stale` | expired, activity since cannot be excluded ⇒ `null` **with a reason** |
  | `unreadable` | roster knows the account, no usable observation ⇒ `null` **with a reason** |

- [ ] `rolled` prints its **precondition in the payload** ("no activity observed by THIS machine"). It
      is an inference, and the same account used from another host breaks it. A consumer must be able to
      tell an inference from a measurement; a rotator that cannot is the failure this doctrine exists to
      prevent.
- [ ] `unreadable` is never an absent row. The outage above is exactly "not exhausted, unreadable", and
      a missing row renders identically to an account with no headroom.
- [ ] Per-account `mode`; where 5h/7d are not the governing constraint, `null` **with a reason**, never
      `0` — the contract `calibrated-exceeded` already honors.

## Phase 3 — payload normalization the corpus measured against the live endpoint

- [ ] Accept `utilization` **or** `used_percentage` for the percentage.
- [ ] Accept `resets_at` as unix **seconds or ms**, as a **number or numeric string**, or **RFC3339**
      (`ccbroker`'s `secOrMsToMs`, `< 1e12` ⇒ seconds).
- [ ] **Model-scoped weekly buckets must not count toward an account-wide "spent" verdict** — a spent
      per-model bucket does not block other models. Check `budget`'s model-scoped reporting against this.

## Verification

- [ ] Regression tests **verified to fail** against the unfixed version — in particular a `rolled` row
      computed from a synthetic observation whose `resetsAt` is in the past, and an `unreadable` row that
      must not collapse into a missing entry.
- [ ] A sample payload handed to ai-maestro to test the rotator against **before the shape is frozen**
      (offered in the issue comment).

## Open lead, not a confirmed bug

`sentinel-main-2` warns that `organization.has_extra_usage_enabled` is org-level and true for any team
org with Max members, so it cannot identify whether THIS user has a Max seat — it uses
`account.has_claude_max` instead. We read `hasExtraUsageEnabled` from `~/.claude.json`'s `oauthAccount`
(`src/accountInfo.ts:68`), i.e. Claude Code's own flattened copy, so the warning may not apply. It
matters because `src/ttlContext.ts:60` uses that flag to pick the cache-TTL regime — a 2× cost
difference. **Verify on a team-org seat; do not "fix" it on the strength of another project's comment.**
