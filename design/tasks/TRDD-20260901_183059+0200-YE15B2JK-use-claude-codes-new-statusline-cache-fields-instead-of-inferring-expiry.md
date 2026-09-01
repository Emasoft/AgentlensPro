---
trdd-id: YE15B2JK
title: Claude Code now reports cache state in the statusline payload so cache-expired should read it instead of inferring
column: ai_review
created: 2026-09-01T18:30:59+0200
updated: 2026-09-01T19:50:43+0200
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
- [ ] `rate_limits.spend_limit` column populated from a real gateway-captured row (not yet observed).

## Notes and lessons learned
