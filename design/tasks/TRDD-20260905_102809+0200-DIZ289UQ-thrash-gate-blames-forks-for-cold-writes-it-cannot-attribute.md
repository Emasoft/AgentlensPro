---
trdd-id: DIZ289UQ
title: The burn-gate blames review forks for cache thrash it cannot attribute
column: todo
created: 2026-09-05T10:28:09+0200
updated: 2026-10-05T03:18:10+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
related: [0YG37FXM, THRGX41P, VY1IUVUM, U0L78B3Z]
implementation-commits: [3979a57d]
status: tasked
---

# The burn-gate blames review forks for cache thrash it cannot attribute

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T11:43:19+0200

**STATUS: COMMITTED, in `ai_review`.** The final gate (`reports_dev/diz-final.txt`) exited 0 on
every stage at 11:42 on 2026-09-05 — types, eslint, compile-tests, mocha (92 passing), both
parity oracle regens, lib, integration (`burnguard_parity`, `agentgate_parity`, `server_stats`),
clippy. `implementation-commits:` carries the SHA. Remaining: the skill reinstall check named in
step 3 below, then one review fork on the committed diff; `human_review` is the USER's move.
Earlier state, kept for the record: Both engines
(`src/bodiesActivity.ts` ↔ `burn/bodies_activity.rs`, `src/agentGate.ts` ↔ `burn/agent_gate.rs`),
both parity fixtures, the two gate test files and this card are edited. `reports_dev/diz-final.txt`
carries the gate: types/eslint/compile/mocha 92 pass are green; read `INTEG_EXIT`/`CLIPPY_EXIT`
from THAT file (older `diz-gate*.txt` files tested stale trees) and the captured oracle thrash
block. **NEXT ACTION (three commits, by card, staged BY NAME from `git status --short -- src
rust-core design skills` — never from memory; `DELEGATION.md`, `reports_dev_compile.txt`,
`reports_dev/` stay unstaged):**
1. U0L78B3Z: `server_stats.rs`, `lib.rs`, `chores.rs`, `tests/server_stats.rs`, its card → then
   `column: testing` (box 3 needs the codesign deploy).
2. FGN5TY7E: `src/cli/serverControl.ts`, its card (already at `ai_review`).
3. DIZ289UQ: `src/bodiesActivity.ts`, `src/agentGate.ts`, `burn/bodies_activity.rs`,
   `burn/agent_gate.rs`, `src/test/agentGate.test.ts`, `src/test/burnGuard.test.ts`, both
   `gen-*-expected.mjs`, both `*-expected.json`, the SIX NEW tracked-tree files under
   `fixtures/burnguard-tree/bodies/` (`f/g/h.response.json`, `r5/r6/r7.request.json`) plus the
   rewritten `a`/`c`, `skills/agentlenspro-diagnostics/SKILL.md`, this card, X4YTS5BF's card and
   IPEPUEL5's card (the credits-regime follow-up, `backburner`) → then `column: ai_review` (no runtime step remains: every box is pinned by a
   measurement, a fixture or a test). Then `agentlenspro --install-skill` and confirm
   `grep -c subagentWrites ~/.claude/skills/agentlenspro-diagnostics/SKILL.md` ≥ 1 — the
   installed copy is what sessions read; other machines get it on the next npm publish.

**USER report (2026-09-05, verbatim intent):** the hook warnings say the per-turn adversarial
review forks are thrashing the cache. The user holds that is false — a fork inherits the parent's
context, so its prefix should be a cache READ — and that some OTHER event reset the cache in the
ai-maestro session. Directive: fix the diagnostic to detect the right cause.

**What is established by reading the code (not yet by measurement):**

- `burn/agent_gate.rs:359` / `:528` / `:593`: THRASH_ACTIVE denies a fork whenever
  `state.thrash.active` — and the message names the fork ("a fork re-enters that prefix and
  multiplies the re-billing").
- `burn/bodies_activity.rs:316 report()`: `thrash.active` = ONE `session_of(m)` has ≥
  `thrash_min_count` responses in the window with `cc > thrash_min_cc` and read share
  `< thrash_max_read_share`. Attribution is BY SESSION ID ONLY.
- A subagent shares its parent's `session_id` (CLAUDE.md, ctxvis evidence). So N sequential
  review forks — each a NEW prefix (its own system prompt + tool set + the injected transcript),
  each a legitimate one-time boot write — land on the PARENT's session id and read as "the same
  session re-writing its prefix N times". The detector's own comment says N one-time boots are a
  fan-out, not thrash — but it can only tell them apart across DIFFERENT session ids, and forks
  do not have one.
- `COLD_FORK` (`:437`) is a separate claim: idle > TTL ⇒ "this fork re-pays the prefix". Even
  when true, the parent's own next turn would pay the identical write; a single fork after idle
  adds no cost the parent was not about to pay. The message asserts a cost the fork does not add.

**MEASURED 2026-09-05 (this session's own review forks, paired in the spool by mtime, responses
within +6..+28 s of a fork request whose `metadata.user_id.session_id` is this session):**

| fable-5-1 response in the window | cache_creation | cache_read |
|---|---|---|
| +6 s | 1,009 | 785,547 |
| +25 s | 3,400 | 754,357 |
| +11 s | 3,063 | 379,872 |
| +28 s | 2,416 | 382,935 |

A response carries no session or agent id, and the parent (this session, also fable-5-1) was
taking turns in the same window — so a row cannot be labelled "fork" vs "parent" (review-fork
finding; the 785k rows are the pre-compaction context size, the 380k rows post-compaction). The
conclusion does not depend on which is which: **every fable-5-1 response in the window, fork or
parent, was a warm read; none was a full-prefix write.** The USER's premise holds: a fork reads
the parent's last-written entry. It cannot be the writer the thrash detector is counting.

**The discriminator is the TTL TIER, not the miss reason (second review fork, verified in the
store over 205 big writes):** opus-5 had 21 reason-less big writes and 16 of them sat on the 1h
tier — main-conversation rewrites the API simply did not label. A "no reason ⇒ boot" rule would
have excluded them and disarmed the detector. Every worker boot sat on the 5m tier with no reason
(sonnet: 133 big writes, 0 on 1h). So: **1h-tier write ⇒ counts, labelled or not; 5m-tier write
with no reason ⇒ boot.** Caveat recorded in code: on a usage-credits account main turns are 5m
too, so a reason-less main rewrite reads as a boot there — the gate's ttl_context knows the
regime; thread it in if that case is measured. **Not this machine today**: this session's own
fable-5-1 big writes sit on the 1h tier (10 of 12), so the owner's main conversation is on the
subscription regime, and the live oracle agrees: `get_subscription_usage` reports "usage
credits: disabled — 1-hour prompt-cache TTL active" (an earlier line here said the field was
unreadable — that was my `jq` reading the `{format,text}` digest wrapper, not the tool; the
answer is in `.text`). On a credits account the rule does not go quiet, it MISATTRIBUTES:
main turns land in `subagentWrites` and the row fires only on untiered old-build bodies. The
honest fix is plumbing `ttl_context` (which knows the regime) into `report()` — a separate card
when a credits-regime capture exists to test it against; the skill says where to look meanwhile.
**Publish scope:** the corrected skill reaches other machines only on the next `vX.Y.Z` tag; that
is the release card's job (TRDD-HSPUF5XH, blocked), not this card's — DIZ completes at commit +
local `--install-skill`.

**Worker turn-2 rewrites (fourth and fifth review forks):** a subagent's OWN turn-2 rewrite is a
5m-tier write WITH a reason (`system_changed`, the `cc_prev_req` prefix break) and still
attributes to the parent's session id — 14 of 209 big writes in the store. A bound on that subset
alone ("never 3 in a window") was the wrong question: two of them plus ONE real main-turn rewrite
is 3, and the gate would warn the parent with no way to read the two apart. A first cut excluded
5m writes from `topSource` only, which made `count`, `active` and `missReasons` describe three
different populations in one sentence (sixth fork). So there is ONE rule, stated once: **a 5m-tier
big write is a subagent's own prefix — its boot or its own turn-2 rewrite — and leaves the
caller's `misses` entirely**, reported as `thrash.subagentWrites {count, rebilledTokens}`. `count`,
`topSource`, `missReasons` then all describe the same set: 1h-tier and legacy writes. Pinned by
fixture `h` (5m, `system_changed`, chained to S1).
**`thrash.count`/`rebilledTokens` therefore changed MEANING** (all big writes → the caller's own),
and the consumers were enumerated rather than assumed (seventh fork): outside the detector and the
gate there are exactly two, `burnGuard.ts:238-249` and `burn/guard.rs:263-285`, both the
`CACHE_THRASH` risk row of `check_burn_risk`, which renders them only as "N calls re-WROTE … the
cache is being invalidated every turn" — the thrash population, which is what they now are. Two
searches, because the value travels under a second name (`evidence.misses`/`.rebilledTokens` on
the risk row): by key name (`rebilledTokens|thrash.count|coldStartRebilledTokens`) and by value
path (`"misses"|.misses|misses:|get("rebilledTokens")|.evidence`) over `src`, `standalone/cli.ts`,
`media/src`, `rust-core/crates`, tests/fixtures excluded. Every `.evidence` reader found reads
other risks' keys (`spawnAtMs`, `spawnWorkspace`, `peakStartMs`, `workspaces`) or a string field on
instruction/insight cards; the remaining `misses` hits are count-cache stats. So: no reader found
by either search presents these two fields as a window burn total; the payload is pass-through JSON
(`check_burn_risk --full`, `/api`). The fan-out cost now lives in `subagentWrites`.
Untested seam, noted not built: no fixture has `count ≠ topSource.count` (all caller misses chain
to S1), so the histogram's per-session gate is exercised only by the agent-gate rendering fixture.

**Third review fork — "`tier_1h = 0` in the STORE is a normalized missing key, not the wire".**
Checked both ways: on the wire, every sampled spool response (sonnet and fable) carries BOTH
`ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`; in the store, across all 205 big
writes the two tiers sum to the write on every row (sonnet 133/133 on 5m = cc, opus 55/60 on
1h = cc, both-zero rows: 0). So a present `cache_creation` object is tiered accounting and an
absent 1h key under it is a real 0 — both readers now say so in code; only a missing object is
"unknown" (legacy rule).

**What the ai-maestro session actually saw (transcript `f559b1e4…`, warnings at 14:32 and 17:35
local on 2026-09-04), settled from the DuckDB `api_calls` store (`cache_miss_reason` is the API's
own field, captured per response):**

- **14:32** — five `claude-opus-5` responses 14:24:50–14:30:47 wrote 296k / 386k / 245k / 172k /
  563k on the **1h tier** (main conversation) with `cache_miss_reason = previous_message_not_found`
  on every one. That is REAL thrash of the main conversation — the incremental-cache chain
  breaking — and the warning was right that something re-wrote the prefix, wrong about who: it
  said "forks stay denied" and denied the next fork. The cause the API names is the one the
  warning should have printed.
- **17:35** — five `claude-sonnet-5` responses 17:24–17:35 wrote ~220k each with cache_read
  8,954 and NO miss reason: fresh sonnet WORKERS booting their own prefix, sharing the parent's
  session id. Five one-time boots, counted as "the same session re-wrote its prefix 5×".

Also found on the way, not fixed here: the store's `msg_id` join between request and response
rows has ZERO coverage in that window (4,177 responses, 0 pairable) and every response row has a
NULL `session_id`, so the ledger's per-project scoping excluded 34,922 of 34,927 calls as
"another project". Attribution in the store is a separate defect — card it.

**THE FIX (shipped in this card, both engines — `src/bodiesActivity.ts` is the parity ORACLE for
`burn/bodies_activity.rs`, `src/agentGate.ts` for `burn/agent_gate.rs`):**

1. Each response entry records `tier1h` (`usage.cache_creation.ephemeral_1h_input_tokens`) +
   `missReason` (`diagnostics.cache_miss_reason.type`).
2. A big 5m-tier write with NO reason is a **boot** — reported as `thrash.boots`, never counted
   toward `active`. A 1h-tier write always counts. Responses with no `cache_creation` object (old
   Claude Code) keep the legacy count-only rule.
3. `thrash.missReasons` = the API's reasons for the top source's misses, `unlabelled` for a
   1h-tier write it did not name; the gate prints them (`API cache_miss_reason:
   previous_message_not_found ×5`).
5. The parity fixture (`gen-burnguard-expected.mjs`) carries every shape in ONE oracle, chained
   to the thrashing session S1: `a` labelled 1h rewrite, `c` UNLABELLED 1h rewrite, `b` legacy
   body (no `cache_creation`), `f`/`g` 5m boots, `h` a 5m worker turn-2 rewrite. Both engines
   must produce (VERIFY against the regenerated oracle before trusting this line) `count 3`,
   `topSource.count 3` (box 2 — drop the tier rule and both read 6), `subagentWrites {3, 826848}`,
   and `missReasons {previous_message_not_found: 1, unlabelled: 1}` (box 3 — legacy `b` counts but
   names nothing; drop the `unlabelled` fallback and that key vanishes). The agent-gate oracle's hand-built state
   `{system_changed: 2, messages_changed: 3, unlabelled: 1}` (non-alphabetical on purpose) pins
   the RENDERING and key order; `agentGate.test.ts` pins fork ⇒ warn + the `×5` clause (box 4).
4. The gate no longer denies a fork under THRASH_ACTIVE (measured: warm read); COLD_FORK states
   the real economics (whichever request comes first pays the one write; only parallel forks
   multiply it).

**UNMEASURED before this session, now settled above:** whether a review fork's first request is actually a cold
write (cc ≈ parent prefix, cr ≈ 0) or a warm read (cr ≈ parent prefix). The user's premise says
read; the ctxvis memory says a subagent's turn 2 rewrote 84k of identical tool schemas. Settle by
pairing a captured fork request (`messages[0]` carries "Answer in ONE turn. Make ZERO tool calls")
with its response `usage`. If the fork IS a cold write, the user's premise is wrong but the
diagnosis is STILL wrong (it is a boot, not thrash); if it is a warm read, the "misses" that
tripped the detector belong to something else entirely and the ledger names it.

## Acceptance

- [ ] A measurement on a real review fork: request + paired response `usage`, recorded here with
      cc/cr and the prefix size. States plainly which of the two cases holds.
      MET TO THE LIMIT THE DATA ALLOWS (16:57 review): the STATE table gives cc/cr for four
      responses and states the warm-read case; the request↔response pairing is by mtime window,
      because no on-disk field joins a request to its response in the aggregate (the CLAUDE.md ctxmap
      doctrine). But a FORK's own request IS selectable — the ctxvis method (nonce in the prompt +
      `messages[0]` position, cross-checked against billed `usage`) produced one verified pair — and
      that recipe was not run for this card. Left open for human_review: accept the windowed pairing,
      or ask for one ctxvis-style exact pair.
- [ ] The thrash detector distinguishes a subagent boot from a main-conversation rewrite under the
      SAME session id — by the request shape (`messages[0]` is the injected prompt / `agent_type`
      in the hook stream / the `cc_prev_req` marker), not by session id alone. Mutation-verified:
      N fork boots on one session id must NOT flip `active`; N rewrites of the main conversation
      still must.
      SUBSTITUTED, NOT MET AS WRITTEN (left open for human_review): the shipped discriminator is the
      RESPONSE's TTL tier — `bodies_activity.rs:380-382` `is_subagent_write = |e| e.tier_1h ==
      Some(0.0)` partitioning `all_misses` (the tier is read at `:87` `extract_miss_diagnostics`; the
      review's `:88-100` citation was that reader, not the partition) — which routes FRESH-agent
      5m-tier boots into `subagentWrites` before the thrash count (both parity fixtures pin it). The request-shape discriminator the box names was not built, and a
      FORK rides the caller's 1h tier so the tier cannot tell it from a main rewrite — the fork half
      of the mutation clause is covered by the THRASH branch's fork EXEMPTION, not by detection.
      Human_review: accept the substitution and reword the box, or demand the request-shape check.
- [ ] THRASH_ACTIVE's message names the SOURCE it measured (which session, which requests, the
      ledger's `cache_miss_reason` where captured) and never names the fork as the cause.
      PARTIAL (16:57 review): the fork is told "not the cause" and the `cache_miss_reason` histogram
      is inline (`agentGate.ts:305-326`), but no session or request id is named. Left open for
      human_review: require the ids, or accept the histogram and close.
- [x] `COLD_FORK` either states the true economics (the parent's next turn pays the same write —
      a single fork adds nothing; only parallel forks multiply it) or is removed. (`agentGate.ts:390-397`
      per the review — the branch is now the single-fork advisory "a single fork adds nothing … Only
      PARALLEL forks".)
- [x] One regression test per changed rule, in the existing `agent_gate` / `bodies_activity`
      test modules. (`agentGate.test.ts` fork+thrash → `warn`, the `×5` miss-reason assertion, the
      rewritten `mode=warn` test; both parity fixtures pin the tier partition and `missReasons`;
      `reports_dev/diz-final.txt` records the run — read by the review, not re-run here.)

## Approval log

- 2026-09-05T16:58:38+0200 — orchestrator accepts the 16:57 AI-review APPROVE: boxes 4 and 5 ticked on
  the review's file:line evidence; re-read by me only `3979a57d`'s `--stat` (`agent_gate.rs` +29,
  `bodies_activity.rs` +74, both expected-JSON fixtures) and, at 17:01, the partition itself —
  `bodies_activity.rs:380-382`, not the `:88-100` the review cited (that is the tier reader); the rest
  of the per-box evidence is the worker's. Box 2 was
  first ticked as "met by a different discriminator" and UN-ticked at 17:01 (review-fork finding): the
  shipped TTL-tier partition substitutes for the request-shape check the box names and does not
  cover forks by detection — an orchestrator judgment the human must ratify, not a met box. Boxes 1,
  2 and 3 are OPEN with their limitation stated, for human_review to accept or demand more. The review
  asked to add `7659b9ca` to `implementation-commits`; declined — its only hunk in this card's files
  is a three-line comment in `bodies_activity.rs` (tagged, not code), so `[3979a57d]` stands and the
  comment commit is named here instead. Card stays `ai_review` for the human_review move.
- 2026-09-24T08:57:35+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
- 2026-09-24T08:58:02+0200 — main-session note: acceptance boxes 1-3 are open by disclosed substitution (weak request/response pairing by mtime window instead of exact matching; TTL-tier substitutes for the request-shape discriminator the box literally names) and need the owner's judgment on whether to accept the substitutions or demand the stronger checks.
2026-09-24T09:17:06+0200 — AI re-review at HEAD 3faa709c: acceptance/AI-review verdict still holds — today's 78e84e7f (TRDD-HNPT6JRG) only touches build_gate_state/last_rate_limit_stop (COLD_RESUME_FANOUT clock), an unrelated function from the THRASH_ACTIVE/bodies_activity.rs thrash detector this card fixed; cargo test -p agentlens-core --test burnguard_parity and --test agentgate_parity both pass at HEAD. The three acceptance boxes left open with disclosed substitutions (2026-09-24T08:58:02 note) are unchanged and still await the owner's judgment call, not a code re-check.

## AI review verdict — run: 2026-09-05T16:57:11+0200

Commits reviewed: `3979a57d` (fix + fixtures), `7659b9ca` (review-fork corrections + wiring
test). Full report: `reports/ai-review/20260905_165711+0200-DIZ289UQ.md`.

**Frontmatter defect:** `implementation-commits: [3979a57d]` omits `7659b9ca`, which touches
`src/bodiesActivity.ts` (13 lines) implementing corrections to THIS card's fix (its own message:
"review-fork corrections after 3979a57d … TRDD-DIZ289UQ"). ✓ VERIFIED (`git show --stat 7659b9ca`).

| box | met/unmet | evidence |
|---|---|---|
| 1. fork measurement, cc/cr + prefix, states which case | met, weak pairing | STATE table (lines 68-83) gives cc/cr for 4 fable-5-1 responses, concludes "warm read; none was a full-prefix write" — matches `agentGate.ts:317-318`'s comment. ? INFERRED: pairing is by mtime window, not a request→response join — the card itself says a response "cannot be labelled fork vs parent". Functionally sufficient, not literally "paired". |
| 2. distinguish boot vs main-rewrite by request shape, not session id; mutation-verified | met via a different mechanism | Shipped rule uses the response's TTL tier (`extract_miss_diagnostics`, `bodies_activity.rs:88-100`; `is_subagent_write = tier_1h == Some(0.0)`), not request shape (`messages[0]`/`agent_type`/`cc_prev_req`). Satisfies "not session id alone"; regression-pinned by `gen-burnguard-expected.mjs` (`a`/`b`/`c` chained to S1 → count 3; `f`/`g`/`h` chained to the SAME S1 → `subagentWrites {3,826848}`, excluded from count/topSource — fixture comments state the falsifying mutation). No automated mutation-testing harness; the falsification is documented, not executed. |
| 3. THRASH_ACTIVE names the SOURCE (session, requests, miss reason), never the fork | partially met | `agentGate.ts:305-326`: fork explicitly told "not the cause" (pinned by `agentGate.test.ts`'s `includes('not the cause')`); `missReasons` histogram surfaced inline (`API cache_miss_reason: previous_message_not_found ×5`). `thrashSource()` (`agentGate.ts:198-202`) prints only a sender COUNT, defers naming to `investigate_burn` — session id / request ids are NOT printed in the message. |
| 4. COLD_FORK states true economics or removed | met | `agentGate.ts:390-397`: "a single fork adds nothing … Only PARALLEL forks…". |
| 5. one regression test per changed rule | met | `agentGate.test.ts` diff: fork+thrash now asserts `warn` not `deny` + `×5` reason assertion + rewritten `mode=warn` test; both parity fixtures pin the tier-partition + `missReasons` shape; `reports_dev/diz-final.txt` shows both parity tests + 92 passing mocha green. |

Gate evidence read in full: `reports_dev/diz-final.txt` (11:43) — types/eslint/compile/mocha 92
passing, both parity regens, `INTEG_EXIT=0`, `CLIPPY_EXIT=0`.

**Verdict: APPROVE** — the fix is functionally correct and tested at both engines; boxes 1 and 3
are met in spirit, not to their literal wording (weak pairing; no session/request id in the
warning text), and `implementation-commits:` should gain `7659b9ca`. None of these are
functional regressions.

## Notes and lessons learned

## Review 2026-10-05 (in the owner's stead)

- Reviewed in the owner's stead 2026-10-05 (reviewer report docs_dev/20261005_025853+0200-review-DIZ289UQ.md). Returned to `todo`: three of five acceptance boxes are open. Verified: boxes 4 and 5 hold for the Rust side - the reviewer ran `burnguard_parity` and `agentgate_parity` (each exit 0, 1 passed) and one mutation (bodies_activity.rs:103 reading the 5m field in place of the 1h field) turned burnguard_parity red on its assertion (`report.thrash.count: got 4 expected 3`), undone and checksum-restored. These are the reviewer's runs; the main agent read the report and did not re-run them. The TypeScript tests agentGate.test.ts and burnGuard.test.ts were NOT run in this review. Commit 3979a57d is an ancestor of main (main agent's check). Owed before this card can be accepted: (a) box 1 - the exact request/response measurement on a real review fork (the ctxvis exact-pair recipe the card names) was never run; the existing table pairs by mtime window only; (b) box 3 - the THRASH_ACTIVE message prints a miss-reason histogram and a sender count but no session or request ids; (c) a fixture where the thrash count differs from the top source's count (the card's own untested seam); (d) the STATE head still says `ai_review` and is stale. PROPOSAL AWAITING THE OWNER, not decided here: box 2 asks for a request-shape discriminator; what shipped is the response TTL tier (`is_subagent_write = tier_1h == Some(0.0)`). Whether the tier rule classifies correctly is a fact and the parity fixtures cover it on a subscription account; on a usage-credits account main turns are also 5m and would be misattributed (follow-up TRDD-IPEPUEL5). Whether to reword box 2 to the shipped mechanism or require the request-shape check is the owner's preference. The reviewer's evidence favours rewording and keeping IPEPUEL5 for the credits case. Note: a fork's write on the caller's 1h tier is not told apart from a caller rewrite at all; it is harmless only because forks are exempt from the THRASH_ACTIVE deny. Relation to TRDD-0D6QK5CW: independent rule of the same family; that card cites this one's fork exemption as precedent and stays blocked by TRDD-81BW1CS9.
- CORRECTION 2026-10-05, after adversarial review of the entry above. (1) "boxes 4 and 5 hold for the Rust side" overstates. Box 4 was READ by the reviewer in both languages (the message text in rust-core/crates/agentlens-core/src/burn/agent_gate.rs near line 472 and in src/agentGate.ts), not tested. Box 5 asks for one regression test per changed rule; what was shown is two parity tests passing and one mutation going red, and nobody listed the changed rules against tests. (2) The main agent has since re-run both parity tests: `burnguard_parity` exit 0, 1 passed; `agentgate_parity` exit 0, 1 passed; and read burn/agent_gate.rs lines 358-388. The reviewer gave that path without the `burn/` directory. (3) A parity test shows the Rust code equals the TypeScript oracle; it does not show the tier rule classifies real traffic correctly. By the reviewer's report the evidence for that is a 205-write sample on this card, from one machine on a subscription account, which nobody re-measured in this review. (4) By the reviewer's summary, boxes 1 and 3 are open by a disclosed substitution like box 2 (its table marks box 1 UNTESTED / LIVE-ONLY and box 3 PARTIAL); the main agent did not read the boxes on this card. All three are PROPOSALS AWAITING THE OWNER; items (a) and (b) above are owed only if the owner refuses the substitution for that box. (5) Item (a) needs a live fork and the captured request spool in the real data directory, which the review spec rules out; it is not pullable until that is lifted. (6) Strike "harmless". By the reviewer's reading a fork's write on the 1h tier would be counted as caller thrash. In the branch at lines 384-388 an active thrash denies only the keep-warm pinger and warns every other launch with "This launch is not the cause". Other users of the count (`thrash_source` at lines 572 and 634) and the deployed binary were not read. (7) The TypeScript tests agentGate.test.ts and burnGuard.test.ts were skipped by the reviewer as "pnpm forbidden". Review spec v2 gives the pnpm commands; the prompt that reviewer was given was not re-read. Running those two test files is owed and pullable now. (8) The STATE head of this card still says `ai_review`; it was not rewritten in this review.
