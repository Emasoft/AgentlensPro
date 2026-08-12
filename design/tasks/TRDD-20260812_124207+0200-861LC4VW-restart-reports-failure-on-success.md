---
trdd-id: 861LC4VW
title: server restart reports a failed start and NOT RUNNING on a restart that succeeded
column: todo
created: 2026-08-12T12:42:07+0200
updated: 2026-08-12T12:42:07+0200
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

## Suspected mechanism — INFERRED, not yet confirmed in code

The single-instance guard is keyed on the data directory (atomic `wx` lock, stale-lock takeover,
ownership-checked release). The restart path appears to retry the spawn, so the *losing* racers in
its own retry loop each hit the guard and print `Refusing to start` — messages about the restart's
own attempts, not about a foreign process. The trailing `NOT RUNNING` is then read before the
winner has finished binding.

Confirm this against `src/cli/serverControl.ts` before changing anything; do not treat the
paragraph above as established.

## Acceptance criteria

- [ ] The mechanism is confirmed (or refuted) by reading the restart path, and the finding is
      recorded here. If refuted, this card is re-scoped rather than patched to fit the guess.
- [ ] A restart that ends with a live server exits 0 and prints no `Refusing to start` line
      attributable to its own retry attempts. A refusal caused by a genuinely foreign owner must
      still be printed — suppressing that would trade a false alarm for a silent one, which is
      worse.
- [ ] The final `status` line reflects the post-restart state, i.e. it is not read before the
      winner has bound its ports.
- [ ] A test that FAILS against today's code and passes after. Falsify on behaviour (the exit
      code / the absence of self-inflicted refusal lines), never on a missing symbol.

## Do NOT

- Do not "fix" this by silencing the guard's message, or by having `status` retry until it likes
  the answer. Both hide a real refusal.
- Do not run a restart on this machine purely to reproduce it while ~20 Claude sessions are live.
  Reproduce it against a scratch `DATA_DIR` + `HOME`, the way every test in `src/test/` does —
  changing ports alone does NOT isolate an instance, because both processes still share the data
  directory.
