---
trdd-id: 861LC4VW
title: server restart reports a failed start and NOT RUNNING on a restart that succeeded
column: complete
created: 2026-08-12T12:42:07+0200
updated: 2026-08-13T22:25:00+0200
current-owner: claude-agentlenspro
task-type: bugfix
approval-tier: 0
scope: project
project-id: agentlenspro
labels: [cli, observability, usability]
severity: low
effort: small
npt: []
eht: []
---

# server restart reports a failed start and NOT RUNNING on a restart that succeeded

## Observed (verified first-hand, 2026-08-12 ~12:32)

`agentlenspro server restart` printed **three** `Refusing to start` lines naming pids 57553 and
40460, and the `status` line that followed said **NOT RUNNING**. It read as a failed restart and an
outage.

It was neither. Thirteen seconds later pid **40460** — one of the pids the output had just named as
a refusal — was serving on 3000 and 4318, and it is the process still running now (verified from a
`ps` snapshot: `Wed Aug 12 12:32:14 2026`, uptime consistent with `server status`). The restart had
in fact succeeded at the moment it announced failure.

## Why this is worth fixing even though it is cosmetic

The output inverts the operator's conclusion at exactly the moment they are most likely to act on
it. The documented remedy for a failed restart is to restart again — which, on a server that is
already mid-startup, produces another round of the same refusals and can genuinely thrash a healthy
process. Worse, this project's own doctrine says a restart interrupts ~20 concurrent Claude
sessions, so a spurious "it failed" invites an expensive and needless second interruption.

It also poisons diagnosis of a real card: TRDD-34B9JAZK (server OOM) will be investigated partly
from restart-time output, and a startup path that cries failure on success is noise in exactly that
signal.

## ~~Suspected mechanism — INFERRED~~ → REFUTED 2026-08-12 by reading the code

The guess recorded at filing was: *"the restart path retries the spawn, so the losing racers in its
own retry loop each hit the guard and print `Refusing to start`."* **That is wrong.**
`ensureServer()` (`src/cli/serverControl.ts:89`) spawns **exactly once** — there is no retry loop,
so there are no self-inflicted racers. It already handles a lost race correctly and deliberately:
lines 116-118 consult `findServerPid()` only when our own child is gone, treating another server
winning as *"a success, not a death"*, and lines 131-135 report the pid that is actually **serving**
rather than the child we spawned.

Kept rather than deleted because the guess is the point: it was plausible, it was written down as
INFERRED, and reading 130 lines refuted it in one pass.

## Verified mechanism

`Refusing to start` is emitted by the **server process** (`standalone/server.ts:197`), whose stdout
and stderr are redirected into `server.log` (`serverControl.ts:84,92`). That log is **one
append-only file shared by every process that ever started a server for this data dir** — every
hook's `ensureServer`, every concurrent CLI — and, measured here, **it carries no timestamps at
all**.

Measured on this machine at the time of the incident:

- **29** accumulated `Refusing to start` blocks in a 15 MB `server.log`.
- They name **four different owner pids** (37104, 80877, 57553, 40460) — i.e. four unrelated eras.
- **One refusal is three lines** (the refusal, "Only ONE server may run…", "Use `server status`…").
  The "three lines" in the original report were therefore **one** refusal, not three.
- `logTail(8)` prints the last 8 lines ⇒ ~2.7 blocks ⇒ which is exactly why the output showed both
  57553 and 40460.

The inversion is the dangerous part. A refusal names the pid that **won**: *"another server (pid
40460) already owns this data directory"*. 40460 was the healthy owner being protected — but a
reader scanning a tail printed under a failed command reads it as "40460 refused to start". That is
precisely the wrong conclusion, and it is the one the original report drew.

## Fixed

`logTail(lines, fromOffset)` now reads only the bytes appended **since our own spawn**
(`logSizeNow()` is captured immediately before `spawn`, and both error sites pass it). An attempt
that wrote nothing says so explicitly rather than borrowing someone else's last 8 lines; a log
rotated under us is reported as rotated instead of quoted from a stale offset; and the scope is
stated in the header, because "the last 8 lines" and "the last 8 lines we wrote" are different
claims that a reader acts on differently. The unscoped call is unchanged, so existing callers keep
working.

## Acceptance criteria

- [x] Mechanism confirmed **or refuted** by reading the code, finding recorded here. It was
      REFUTED, and the card was re-scoped to the real cause rather than patched to fit the guess.
- [x] No foreign/historical refusal is quoted as this attempt's diagnosis. A refusal our own child
      genuinely emits is still shown in full — the fix scopes the tail, it does not silence the
      guard, so a false alarm was not traded for a silent one.
- [x] Tests that FAIL against unfixed code and pass after. Falsified on **behaviour**, not on a
      missing symbol: `logSizeNow` was left in place and only the offset arithmetic was neutered, so
      the two scoping tests failed on content (`'a refusal by another process must not appear'`,
      `'expected an explicit "wrote nothing"'`) with the other 2237 tests untouched.
- [x] **The second half is now ESTABLISHED and fixed (2026-08-13).** It recurred live at 19:23
      during a deploy, with the scoped tail already in place — so the evidence was clean: restart's
      own child lost the single-owner race to a concurrent hook's spawn (winner pid 65252), the
      winner spent its first seconds BOOTING (first DB open is O(store)) and answered nothing, and
      `findServerPid()` — which only recognizes a server that already SERVES — returned null. So
      `startupVerdict` had `childExited && !anotherServing` and declared `died`; restart printed
      `FAIL: the server exited during startup` while the winner came up healthy 16s later (status
      then showed RUNNING pid=65252). The same boot-window blindness explains the original
      `NOT RUNNING` status line: `showStatus()` probed the winner mid-boot and got connection
      refused — a follow-on status after a restart that WAITS no longer lands in that window.
      Fix: `startupVerdict` gains `raceWinnerAlive` — read from OUR OWN attempt's scoped log bytes
      (`raceWinnerPid(logStart)`: the guard's refusal line names the winner) + a signal-0 liveness
      probe; a live winner is a start in progress (`keep-waiting`), a dead one stays `died`, and
      the ready deadline still bounds a winner that boots forever. The guard's message is untouched
      (per Do NOT), historical refusals stay invisible (offset-scoped, tested), and a genuine death
      with no refusal stays an immediate death.

## Approval log

- 2026-08-13T22:25:00+0200 — COMPLETED via delegated review. USER (verbatim, 2026-08-13): "you can
  review them youself. just base your review of verified facts, not assumptions." Facts verified
  first-hand at review time: guard string at standalone/server.ts:197 matches raceWinnerPid's regex
  exactly; startupVerdict has exactly one production call site (serverControl.ts:132) carrying the
  new raceWinnerAlive field; family suites 27 passing / 0 failing isolated; CI green on main at
  92e9491; both halves' mechanisms were established from LIVE occurrences (2026-08-12 12:32 and
  2026-08-13 19:23), not reproduction guesses. Residual noted, not blocking: on a timeout after a
  lost race the message still says "the process we started has exited" — truthful, and the scoped
  tail names the winner alongside it.

## Do NOT

- Do not "fix" the remaining half by silencing the guard's message, or by having `status` retry
  until it likes the answer. Both hide a real refusal.
- Do not run a restart on this machine purely to reproduce it while ~20 Claude sessions are live.
  Reproduce against a scratch `DATA_DIR` **and** `HOME`, the way every test in `src/test/` does —
  changing ports alone does NOT isolate an instance, because both processes still share the data
  directory.
- Do not add timestamps to `server.log` as the fix for this card. It is a real improvement and a
  much larger change (the lines come from the server's own `console.*`, not from a logger), and
  scoping the tail solves the reported defect without it.
