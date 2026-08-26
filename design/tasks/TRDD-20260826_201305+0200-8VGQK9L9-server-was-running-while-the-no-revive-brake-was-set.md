---
trdd-id: 8VGQK9L9
title: A server was running for 1h53m while the NO_REVIVE brake file was in place
column: backburner
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T20:13:05+0200
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [server, lifecycle, safety-mechanism]
relevant-rules: []
---

## Observation (symptom only — the cause is NOT established)

On 2026-08-26 ~19:50, `agentlenspro store repair-parked` refused with:

```
REFUSED: the server is running — it would keep writing into the swapped-out store.
```

which was the correct refusal. But the server should not have been running:

| fact | evidence |
|---|---|
| brake file present | `~/.agentlens/NO_REVIVE` contained `server stop --stay-down 2026-08-25T20:42:30.012Z` |
| server up 1h53m | `ps`: pid 94096, ppid 1, `node …/standalone/server.js`, etime 01:53:41 |
| it owned the DEFAULT data dir | `server status`: `canonical=true`, `data: ~/.agentlens (default)` |

The brake's contract, from its own message: *"hooks and the supervisor will not resurrect the
server; `agentlenspro server start` clears it."* A `server start` would have CLEARED the file.
The file was still there, so whatever started this process did not go through that path.

## What is NOT known

**Do not read the above as "the brake was bypassed" — that is the hypothesis, not the finding.**
Candidates not yet distinguished:

1. A start path that does not consult the brake (hook, supervisor, launchd, or a test harness).
   The repo's own suite spawns servers (`src/test/cliHotPathLatency.test.ts`), and several full
   test runs happened in that window — but those use their own `DATA_DIR`, and this process
   reported the default one, which argues against it.
2. A deliberate manual start by another session on this machine (two were active).
3. The brake being written AFTER a start, leaving a true-but-misleading file.

The server log carries no start-provenance line, which is itself part of the problem: there is no
record of WHO started a server or WHETHER the brake was consulted.

## Why it matters

The brake exists so an operator can take the server down and keep it down while doing exactly
what was being done here — swapping the store underneath it. A brake that can be silently
defeated is worse than none, because the operator proceeds believing it holds. In this instance
the repair's own independent check caught it; that check should not be the only thing standing
between a store swap and a live writer.

## Acceptance

- [ ] Every start path is enumerated and each is shown either to consult the brake or to be
      unreachable, at `file:line`.
- [ ] The server records its start provenance (who/what started it, whether a brake was present)
      so this question is answerable from the log next time instead of by inference.
- [ ] A test that sets the brake, exercises each start path, and asserts no server comes up.

## Not in scope

The repair's refusal behaviour — that worked correctly and needs no change.
