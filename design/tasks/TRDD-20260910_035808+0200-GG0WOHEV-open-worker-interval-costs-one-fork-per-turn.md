---
trdd-id: GG0WOHEV
title: A background worker's open interval makes the review gate demand one fork per write-then-Stop cycle
column: backburner
created: 2026-09-10T03:58:08+0200
updated: 2026-09-10T04:24:02+0200
current-owner: main
task-type: spike
priority: low
severity: low
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [review-gate, hooks, token-burn, subagents]
related: [3U8AIHXK, 9FG0LSPG, 0E3W5C45, 2CYTNLY1]
blocked-by: []
npt: []
eht: []
implementation-commits: []
---

# A background worker's open interval makes the review gate demand one fork per write-then-Stop cycle

## Why

Observed 2026-09-10 03:56-04:01 while the TRDD-2CYTNLY1 lean-worker edited `src/cli/reviewGate.ts`
in the background: the orchestrating session's Stop was blocked with `left unreviewed changes on
disk: src/cli/reviewGate.ts`. This is TRDD-3U8AIHXK working as designed — the worker's Agent
interval is open (`end = Infinity` until its `<task-id>` notification lands), the write is newer
than the last fork, so the gate fails closed. The exit is a fork spawned LAST; that fork's
completion notification starts a new turn; if the worker wrote again in between, that turn's Stop
is blocked again. Measured: two Stop-hook blocks (03:56:45, 04:00:38 — the second was the
compaction-request Stop, which no fork could exit anyway); one exit fork attributable to the loop,
241,291 subagent tokens (the other two forks in the window were reviews owed regardless). Cost of
the loop = one inherited-context fork per worker write-then-Stop cycle, at the cache-read rate
(the dollar figure was not measured here). The loop is bounded by the worker's runtime, and the
exit fork sees the worker's partial diff, so it is not reviewing nothing — it is reviewing a moving
target.

## Design — decided 2026-09-10 (adversarial review 03:59, paraphrased here)

- **(a) REJECTED — release a write inside a still-open background interval as "pending review",
  arming once at the Stop after the interval closes.** It flips "open interval" from fail-closed to
  fail-open; `DETACHED_JOB` pins a `nohup` / `&` Bash interval open FOREVER by design, so under (a)
  every write during a detached job — the named non-session residual included — is permanently
  pending and never reviewed; a worker that never notifies (TaskStop, crash, `/clear`, session
  exit, compaction eating the notification) is never reviewed; a second worker's writes ride under
  the first's close. That is TRDD-9FG0LSPG's delegation hole reopened plus a standing bypass,
  against the owner's order on TRDD-0E3W5C45.
- **(b) dropped** — not counting a notification-started, text-only turn as needing a fork is a
  bypass shape.
- **(c) impossible** — a notification-started turn ends regardless of orchestrator discipline.
- **(d) NOT chosen; the reviewer's own alternative, kept only as a pointer:** keep the arm; defer
  only for an open AGENT interval whose launch turn already had a fork after it, and arm regardless
  at the second consecutive deferred Stop. If it is ever wanted it is its own TRDD with its own
  acceptance; nothing here commits to it.
- **CHOSEN: no gate change.** The intervening fork reviews the worker's partial diff, or replies in
  one line ("worker still writing; deferring to its report") when it has nothing to add; the
  orchestrator never ends a notification-started turn with text alone while a worker writes.

## Acceptance

- [x] On the next delegated background worker, record on this card the count of exit forks and
      their subagent tokens for that worker's runtime — the cost stays bounded by the runtime.
      Measured 2026-09-10 on the second TRDD-2CYTNLY1 lean-worker (about six minutes of edits):
      four Stop blocks, four exit forks at 361,986 / 367,218 / 370,620 / 373,539 subagent tokens
      (one of the four turns was also used for a card edit); the worker-attributed blocks ended
      with its notification, as designed (a fifth block that followed was this session's own
      `$VAR`-prefixed redirect, not the worker).

## Approval log

- (none)

## Notes and lessons learned

- (none yet)
