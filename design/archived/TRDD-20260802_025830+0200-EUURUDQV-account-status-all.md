---
trdd-id: EUURUDQV
title: get_account_status --all — every observed account, honestly stamped
column: completed
created: 2026-08-02T02:58:30+0200
updated: 2026-08-18T12:45:00+0200
current-owner: session
task-type: feature
npt: []
eht: []
---

# `get_account_status --all` — every observed account, honestly stamped

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-04T23:4x+0200

**THE BLOCKER IS RESOLVED. The consumer's response arrived as GitHub issue #9** (filed by the janitor
6 h after this card was last touched) — the body below still says "AWAITING ai-maestro's response on
the payload shape", and that is now stale. #9 opens by naming the four properties it is relying on
(`unreadable` as a ROW never an omission; `null` never presented as `0`; per-WINDOW freshness; the
explanatory `reason` strings) and then asks for four contract changes. **All four are implemented and
were VERIFIED LIVE today against the deployed 2.23.0 CLI** — behaviour, not help text:

| #9 ask | shipped | measured today |
|---|---|---|
| §1 non-zero exit when the request cannot be answered | `21ad9a4`, `6c22bb3`, `764b235` | `get_agent_tokens --agentId nonexistent-xyz` → **exit 2**, stdout EMPTY, JSON reason on **stderr** |
| §2 a machine-readable flag every tool honours | same | `--json` accepted on `get_agent_tokens`; `help <tool>` now prints `--full` / `--json` / `--out` **and** the exit contract |
| §3 a structured `bound`, so the direction is not read out of English prose | `ed92c3c` | the whole lattice is live: `exact` (fresh) · `lower` (aged) · `inferred` (rolled, with `leftAt` set) · `unknown` (stale, `percent: null` + reason) |
| §4 a corpus-level "is the archive still filling" signal | `ed92c3c` | `archive: {maintained, reason, lastObservedAt}` at top level, plus `blind` |

One deliberate deviation worth telling the consumer: #9 proposed `null` for "no claim"; we ship the
string **`"unknown"`**. A missing key and an explicit no-claim are then distinguishable, which is the
same argument #9 makes for `unreadable` being a row rather than an omission.

**NEXT ACTION:** reply on issues #8 and #9 with the verified table above so the two blocked consumers
(ai-maestro's rotator, the janitor's rotator gate) can integrate — that is outward-facing, so it needs
the owner's go-ahead. Then close both issues and take this card terminal.

**Still open, and NOT blockers** (both are recorded at the end of this card): retention for the
per-account archive (nothing purges it; correct for now, undecided), and the `has_extra_usage_enabled`
lead, which must be verified on a team-org seat rather than "fixed" on another project's say-so.

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
   the owner account while the keychain credential belongs to the second account, so every reading on record is the second account's.

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
- [x] **The response arrived as issue #9, and all four of its contract asks are implemented and
      verified live** — see the STATE block at the top of this card for the measured table. The shape
      is now frozen in that form. What remains is telling the consumers (a reply on #8 and #9).

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

## Approval log

- 2026-08-14T02:48:00+0200 — COMPLETED (human_review → complete) under the owner's standing review
  delegation. Phases 1–3 and every contract item verified in code first-hand
  (reports/trdd-review/20260814_015415+0200-batch2-review.md). The two unchecked boxes are
  DEFERRED, deliberately, with reasons: (1) per-account archive retention — growth is a few KB per
  account per write and the card itself says purging now would destroy the archive's whole value
  (age); revisit only if the directory ever measures as material. (2) `has_extra_usage_enabled` —
  unverifiable on this machine by the card's own rule (needs a team-org seat); the guard text above
  stands as the standing instruction for whoever first has one. Neither blocks the shipped
  functionality, which is what this card delivered.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/allAccounts.ts exists on disk and is referenced from `get_account_status`
  (src/accountStateTimeline.ts:42,57,80).
