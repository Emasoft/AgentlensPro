---
trdd-id: POLG0613
title: One unexplained early-break cold write after a heartbeat fire
column: todo
created: 2026-09-03T04:22:28+0200
updated: 2026-09-03T04:22:28+0200
current-owner: main-session
task-type: spike
priority: normal
min-approval-requirement: none
blocked-by: [CAJ5RCP9]
related: [B9ERTBZ9]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

NEXT ACTION: on the next heartbeat fire, run the H1 capture (one bash: copy
the newest bodies within 5 s of the fire to
`reports/cache-coldwrite/bodies-<ts>/`) then diff against the previous
turn's body. then diff `system[]`/`tools[]` against the previous turn's body.
`blocked-by: CAJ5RCP9` because the durable per-call table would
make this trivial and repeatable, but a manual capture can settle it sooner
— do not wait if a fire happens first.

## WHY

Evidence: `reports/cache-coldwrite/20260902_214248+0200-recurring-cold-writes.md`.
Session ded208f3 had 6 full-prefix cold writes in 57 minutes (each
200-360k tokens written at the 1h tier, ~$4-7 each):

| time | cause |
|---|---|
| 20:33 | `/clear` (expected) |
| 20:37 | `/reload-plugins --force` (documented cause) |
| 20:42 | `/login` (ACCOUNT_SWITCHED, inferred) |
| 20:45 | unexplained |
| 21:24 | within 10-64s of a `scheduled_task_fire` transcript marker |
| 21:29 | within 10-64s of a `scheduled_task_fire` transcript marker |

Of the six, 21:24:13 is the post-restart first turn (a cold start after
a break — expected, not evidence of anything). Only **21:29:49 is
unexplained**, and its row shows `cache_read` 51.3k — an EARLY break, in
the system/tool region rather than a late one. So the real count is
**heartbeat correlation: 1 of 6**, not 2 of 6, and the mechanism is
unmeasurable until CAJ5RCP9 persists per-call `system[]` fingerprints —
this card does not blame the janitor heartbeat anywhere; the fire's
timing is a coincidence to check, not a named cause.

The API's `cache_miss_reason` was empty on all six captured rows, and the
request bodies were already deleted by the bodies pass (only ~30-60s of
bodies live on disk), so the diverging block could not be diffed at
capture time. Per CLAUDE.md doctrine 3/4: cron fires are main-conversation
turns with a 1h TTL; a full rewrite needs something ABOVE the new turn to
change (system prompt, tools, or a spliced block) — a cron fire alone
should NOT cause one.

## HYPOTHESES — each with its ONE settling measurement

- **H1 — a `system[]`/tools mutation on that turn.** UserPromptSubmit
  hook `additionalContext` is delivered inside the new USER message
  (tail), so it cannot break the prefix — ruled out as written. The real
  candidates for an early break are: the `/login` at ~21:2x changing the
  account-identity block in `system[]`, or the attribution
  system-reminder swap observed at 21:24. Settle: capture the next
  heartbeat turn's request body BEFORE the bodies pass deletes it
  (`OTEL_LOG_RAW_API_BODIES` dir, copy files with mtime within 5s of the
  fire), diff `system[]` + `tools[]` against the immediately-preceding
  turn's body.
- **H2 — LOOKBACK_OVERFLOW.** >=20 blocks appended since the last cache
  write (many subagent task-notifications can land between fires) walks
  past the cache-write lookback window. Settle: count appended blocks
  between the last warm turn and the fire from the transcript JSONL.
- **H3 — TTL regime silently dropped to 5m** (usage credits draining
  instead of subscription 1h). Settle: `agentlenspro get_subscription_usage`
  -> check `usageCreditsEnabled`.
- **H4 — statusline row mis-attribution** (the fire's OWN turn vs the
  resume turn immediately after it). Settle: pair the statusline row's
  input-bucket tuple with the cron turn in the transcript by timestamp.

## ACCEPTANCE

- Cause named with supporting evidence, OR all four hypotheses falsified
  with their measurements recorded.
- If H1 confirmed: file a fix proposal (move the janitor's per-prompt
  context to the tail, or make it stable/cacheable) as a GitHub issue on
  the ai-maestro-janitor plugin repo — never edited directly here (see
  `~/.claude/rules/how-to-fix-issues-of-other-projects.md`).
- Do not name a cause that cannot be told apart from the alternatives
  (TRDD-B9ERTBZ9's standing bar).
