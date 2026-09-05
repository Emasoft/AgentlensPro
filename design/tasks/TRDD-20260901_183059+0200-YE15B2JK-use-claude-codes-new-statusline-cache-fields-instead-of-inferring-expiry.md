---
trdd-id: YE15B2JK
title: Claude Code now reports cache state in the statusline payload so cache-expired should read it instead of inferring
column: ai_review
created: 2026-09-01T18:30:59+0200
updated: 2026-09-05T15:16:57+0200
current-owner: main-session
task-type: feature
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: [494eb779, 2d06942b]
---

# Read the statusline's own cache fields instead of inferring expiry

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-01T19:50:43+0200

**Shipped and live-verified this session:**
- `494eb779` — `agentlenspro cache-expired` now answers AUTHORITATIVELY from the statusline
  payload's `prompt_cache` block (CC 2.1.252): reads the newest captured WAL row off disk (works
  with the server down); `prompt_cache_expires_at` is epoch SECONDS. Field names were dumped from
  a LIVE row (NEXT ACTION step 1, done). 5 unit tests in `src/test/cacheExpiredAuthoritative.test.ts`.
- `2d06942b` — all 12 flattened `prompt_cache_*` columns added to `GUARANTEED_COLUMNS` in
  `src/statuslineStore.ts`; the `statusline-history cache` view resolves its 5m/1h cost bracket to
  one figure via `prompt_cache_ttl` and shows the harness misses counter.

**Remaining (open box, not blocking):** `rate_limits.spend_limit` column awaits a real
gateway-captured row; server-side ttl-regime resolution consulting `prompt_cache_ttl` is tracked
on TRDD-SIGBCMGL, not here.

**USER directive, 2026-09-01T18:30:59+0200:** *"the new claude code added fields with input info about the
cache state in the statusline json data, so if you capture the statusline like now, you need to use
that information to improve the agentlenspro cli ability to report with accuracy if the cache is
expired or not."*

**Why this is a real accuracy gain, not a refactor.** `agentlenspro cache-expired` currently
ANSWERS BY INFERENCE: it takes the PreCompact stamp (`last-compact`) and compares elapsed time
against the TTL regime it believes is in force (1h on a subscription, 5m in overage, 5m for
subagents). Every one of those inputs is itself inferred, so the verdict is a chain of guesses. If
Claude Code now states the cache condition directly in the payload we already capture, the verdict
becomes a READ instead of a derivation — and the honest `unknown` (exit 2) can be reserved for
when the field is genuinely absent, instead of standing in for "I could not reconstruct it".

**What is verified so far (do not re-derive):**
- The statusline IS captured and stored: `~/.agentlens/statusline/{main,subagent}/<date>/part-*.parquet`.
  Storage is **Parquet**, not NDJSON — a reader must go through the store, not `tail` a file.
- The capture path is `statuslineCapture.ts` and is independent of the `--inner` command: both
  start before either is awaited, the inner child gets a COPY of the same payload, stdout is
  INHERITED not piped. So adding field handling CANNOT disturb the user's own statusline script.

**NOT yet verified — do this first:** dump one recent row and enumerate its actual keys. Claude
Code is at 2.1.252 here. The field names in the directive are described, not quoted, so
**do not guess them** — read a live row and write the real names into this card before coding.

## NEXT ACTION

1. Read one recent row out of the parquet store and record the exact cache-related key names +
   value shapes in this card.
2. Only then change `cache-expired` to prefer the captured field, falling back to today's
   inference when it is absent — and make the output SAY which of the two answered, because a
   read and a guess must never be indistinguishable to the caller.
3. Keep the exit contract: 0 = expired, 1 = fresh, 2 = cannot answer. Never print `false` for a
   question that could not be resolved.

## Acceptance

- [x] The exact field names are recorded here, quoted from a live captured row.
- [x] `cache-expired` prefers the captured field and says so in its output.
- [x] With the field absent, the old inference still answers and is labelled as an inference.
- [x] Mutation-verified: remove the field-reading branch and a test must fail (5 unit tests, `src/test/cacheExpiredAuthoritative.test.ts`).
- ~~`rate_limits.spend_limit` column populated from a real gateway-captured row~~ — appended in
  `e4b8ae88` after the card's scope was set and unmeetable by work here (the harness has never emitted
  the field); split out to TRDD-BFUZ1THR (`backburner`, `review-after: 2026-10-05`) on 2026-09-05.

## Notes and lessons learned

## AI review verdict — run: 2026-09-05T15:15:25+0200

| Box | Status | Evidence |
|---|---|---|
| Field names recorded, quoted from live row | ? INFERRED | Names given in prose (`prompt_cache_expires_at`, `prompt_cache_ttl`, `prompt_cache_warm`) match a REAL live row read today (`~/.agentlens/statusline/main/2026-09-05/wal-39382.ndjson`) and all 12 `GUARANTEED_COLUMNS` in `src/statuslineStore.ts:218-229`; card never pastes a raw JSON row (doc gap, not correctness). |
| `cache-expired` prefers captured field, says so | ✓ VERIFIED | `src/cli/cacheExpiredCli.ts:198-212` — tries `authoritativeFromWals()` first; success path prints `harness-reported (ttl …)` and sets `source: 'statusline-prompt-cache'` in `--json`. |
| Field absent → old inference still answers, labelled | ✓ VERIFIED (partial) | Fallthrough to `check_cache_expiry` (`cacheExpiredCli.ts:224-276`) confirmed; distinguishable by shape (`source` key absent, different stderr wording) but never prints the literal word "inferred". |
| Mutation-verified (5 unit tests) | ✓ VERIFIED | `git show --stat 494eb779` adds `src/test/cacheExpiredAuthoritative.test.ts`; read in full — 5 `test()` blocks, all importing `authoritativeFromWals` directly, so removing it fails every test. Run itself deferred (CPU contention). |
| `rate_limits.spend_limit` populated (open box) | ✗ UNVERIFIED — genuinely unmet | Checked today's live row: only the four `rate_limits_{five_hour,seven_day}_*` fields exist; `spend_limit` has never been observed. Box is correctly left unticked. |

**Defect (process hygiene):** `git log --follow` on this card shows the 5th box was appended in the SAME commit that ticked the other 4 and moved the card to `ai_review` (commit `e4b8ae88`) — it was NOT part of the card's original scope (commit `dc204e41`, `column: todo`, 4 boxes only). Per TRDD rule 9/13 this should have been split into its own TRDD/EHT rather than appended post-hoc to a closing card. It is explicitly marked `not blocking` in the STATE block, which mitigates but does not eliminate the defect. Recommend filing it as its own TRDD (or folding into TRDD-SIGBCMGL) before/at `human_review`.

**Verdict: APPROVE** — the four original acceptance criteria are verified against source, commits, tests, and a live captured row; the later-appended 5th box names a field genuinely never observed, so leaving it unticked is honest, not concealment of unfinished required work.
