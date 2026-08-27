---
trdd-id: 8VGQK9L9
title: A server was running for 1h53m while the NO_REVIVE brake file was in place
column: dev
created: 2026-08-26T20:13:05+0200
updated: 2026-08-27T14:59:32+0200
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [server, lifecycle, safety-mechanism]
relevant-rules: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-27

**Cause found AND fixed. One acceptance box remains, and it is additive, not a fix.**

| component | state |
|---|---|
| `killSwitch.ts::reviveBraked()` | NEW — the single definition of "is the brake armed" |
| `serverControl.ts::ensureServer()` | gated on the brake at `:139-146`, after the DISABLED gate |
| supervisor loop | unchanged behaviour; its local predicate deleted, now imports the shared one |
| `src/test/killSwitch.test.ts` | +3 tests, 14/14 pass |
| box 3 — start provenance in the server log | **NOT DONE** |

**NEXT ACTION:** make the server record its start provenance — who/what started it and whether a
brake was present — so "who started this?" is answerable from `server.log` instead of by
inference. That question cost this investigation a day and three refuted hypotheses.

**Gotchas that are load-bearing:**
- The pause-vs-kill split is REAL and must survive: the supervisor must check NO_REVIVE **only**,
  because under DISABLED its spawn has to proceed so the child exits EX_CONFIG 78 and the loop
  terminates. Collapsing both into `reviveDisabledOnDisk()` makes a DISABLED supervisor immortal.
- `reviveBraked()` is ENOENT-only-false on purpose. `existsSync` reads EACCES/EIO as "absent", and
  failing open here spawns into a store swap.
- `npx mocha <file>` runs the WHOLE suite (`.mocharc` supplies `spec`). Use
  `npx mocha --no-config --require src/test/setup.js --ui tdd out/test/test/<name>.test.js`.

**SUPERSEDED — do NOT carry forward:** the "What is NOT known" section below lists three candidate
causes. All three are moot: the cause is established at `file:line` and fixed. Keep the section as
the record of what was eliminated; do not re-investigate it.

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

## CAUSE FOUND 2026-08-26 — `ensureServer()` does not consult the brake

The hypothesis below ("a start path that does not consult the brake") is now confirmed at
`file:line`, and it is the FIRST candidate listed — but do not read that as luck: the other two were
eliminated by the same reading.

`ensureServer()` (`src/cli/serverControl.ts:117-140`) gates on exactly ONE thing before spawning:

```ts
if (agentlensDisabled()) { throw … }   // serverControl.ts:120 — the GLOBAL kill switch
```

It never calls `reviveDisabledOnDisk()` and never reads `NO_REVIVE`. The brake is honoured only by
the supervisor loop (`:641`) and the `--supervise` entry (`:713`), and it is CLEARED by
`server start` (`:764`, `:798`). So the brake stops the supervisor and launchd — and nothing else.

**Reachable, not theoretical.** `ensureServer()` is called from at least:

| caller | line |
|---|---|
| `dashboard` verb | `src/cli/main.ts:232` |
| `--start-server` / `--dashboard` globals on any diagnostics invocation | `src/cli/diagnosticsCli.ts:671-673` |

The second is the dangerous one: `--start-server`/`--dashboard` are *global flags*, so an ordinary
diagnostics command carrying either will silently resurrect a deliberately-braked server. That
matches the observation exactly — a server up 1h53m on the default data dir with the brake file
still present and `server start` (which would have cleared it) never run.

This also explains the asymmetry the original write-up noticed: the brake's own message promises
"hooks and the supervisor will not resurrect the server", and for the supervisor half that is true.

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

- [x] Every start path is enumerated and each is shown either to consult the brake or to be
      unreachable, at `file:line`. **DONE — and one does not consult it:** `ensureServer()`
      (`serverControl.ts:117-140`) gates only on `agentlensDisabled()` (`:120`), never on
      `NO_REVIVE`. Reachable from `main.ts:232` (`dashboard`) and `diagnosticsCli.ts:671-673`
      (the `--start-server`/`--dashboard` GLOBAL flags, so any diagnostics command carrying one
      revives a braked server). The supervisor paths (`:641`, `:713`) do honour it.
- [x] `ensureServer()` refuses when the brake is set. **DONE 2026-08-27** — gate added at
      `serverControl.ts:139-146`, immediately after the DISABLED gate and before the `init()` probe,
      so a braked install costs no socket and no spawn.
      The split at the old `:616-623` is PRESERVED, not collapsed: the predicate moved to
      `killSwitch.ts::reviveBraked()` (NO_REVIVE only, ENOENT-only-false so unreadable means
      BRAKED), and `ensureServer()` reaches it only after its own `agentlensDisabled()` gate has
      already thrown — so DISABLED and NO_REVIVE stay distinct exactly as the supervisor needs.
      The supervisor's local copy was deleted in favour of the shared one; it had been the only
      definition, which is how `ensureServer()` came to have none.
      The brake message needs no weakening now — `ensureServer()` was the half that made it false.
- [ ] The server records its start provenance (who/what started it, whether a brake was present)
      so this question is answerable from the log next time instead of by inference.
- [x] A test that sets the brake and asserts no server comes up. **DONE 2026-08-27** — three tests
      in `src/test/killSwitch.test.ts`: the brake reads armed without a restart; `ensureServer`
      rejects with `/revive brake/`; and brake-and-switch stay DISTINCT (braked but NOT disabled,
      and the rejection names the brake, not DISABLED — so a future collapse into
      `reviveDisabledOnDisk()` fails the suite). 14/14 pass.
      The assertion is genuine, not self-satisfying: `revive brake` is thrown from exactly one
      place (`serverControl.ts:142`); the other two occurrences are supervisor log/stderr paths
      unreachable from `ensureServer()`.
      NOT yet covered: the `dashboard` verb and the `--start-server`/`--dashboard` global flags are
      asserted only through `ensureServer()`, the function they both call — not driven end-to-end.

## Not in scope

The repair's refusal behaviour — that worked correctly and needs no change.
