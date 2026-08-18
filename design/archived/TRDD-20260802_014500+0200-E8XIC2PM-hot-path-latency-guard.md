---
trdd-id: E8XIC2PM
title: A latency guard for every CLI command a harness runs on its hot path
column: completed
created: 2026-08-02T01:45:00+0200
updated: 2026-08-18T12:45:00+0200
current-owner: session
implementation-commits: [cc5326c]
task-type: infra
npt: []
eht: []
---

# A latency guard for every CLI command a harness runs on its hot path

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**DONE (`cc5326c`). The guard found a 75-second stall on its first run** — which is the entire
argument for having built it.

`rpc()` and `apiRequest()` called `http.request` with **no bound at all**, so a black-holed connect
waited out the OS connect timeout. `agentlenspro cache-expired` measured **75,103 ms** against the
DROP address — a verb whose documented purpose is answering when the server is DOWN, and 7× worse
than the 10.6 s stall that motivated this card. The earlier hand-fix bounded `hook`/`gate`/
`statusline`, which use a **different transport**; everything on this one was untouched and unlooked-at.

**The fix is a CONNECT deadline, not a request timeout, and that distinction is load-bearing:** a
legitimate call can be slow SERVER-side (`ctxvis` spawns an agent and measures two of its turns), so
an idle-socket timeout would kill correct work — while an unanswered connect is never anything but a
dead endpoint. `AGENTLENS_CONNECT_TIMEOUT_MS`, default 800 ms, cleared on `connect` (fresh socket) or
`response` (pooled socket that never emits it).

Measured after, against 10.255.255.1: hook 1,432 ms · gate 1,225 ms · statusline 931 ms ·
cache-expired 1,018 ms · last-compact 1,006 ms.

**Two test properties that must not be "simplified" away:**
- It runs against an address that **DROPS**. A closed port REFUSES instantly — that is exactly why a
  thorough "server down" suite stayed green while the original stall was live.
- It **SKIPS loudly** where the sandbox refuses instead of blackholing. A green there would measure
  the fast path and mean nothing, which is worse than no test.

**NEXT ACTION:** human review. Deployed locally; not published.

## Why

`agentlenspro statusline`, `hook` and `gate` run on Claude Code's render and per-tool-call paths.
With the server unreachable in a way that HANGS rather than refuses, each took **10.6 seconds**.

The existing end-to-end suite covered "server down" thoroughly and could not see it: every test
points at `127.0.0.1:1`, and a closed port **refuses instantly**. "Unreachable" has two shapes and
the tests only ever exercised the fast one.

The cause is not a missing timeout. `AbortSignal.timeout` fires correctly (704 ms) — it bounds the
REQUEST, while the aborted socket keeps the event loop alive and the CLI was ending by draining it.

Fixed for those three (`1afb69b`, `87466ea`), by hand, with hand-written tests. Nothing stops the
next hot-path command from shipping without the same guard, and nothing checks the commands that
already exist but were not part of that fix.

## Scope

Every `agentlenspro` subcommand that performs network or filesystem I/O.

## Acceptance

- [x] One table-driven test asserting a wall-clock ceiling for every subcommand classified
      `hot-path`, run against an address that **DROPS** (`10.255.255.1`), not a closed port.
      `src/test/cliHotPathLatency.test.ts`. It also refuses to run where the sandbox REFUSES instead
      of dropping (it skips loudly) — a green measured on the fast path is worse than no test.
- [x] The classification lives beside the dispatch in `src/cli/main.ts`, so adding a subcommand
      forces a decision rather than defaulting silently into the untested set. The test derives the
      command set from the `case` labels in the SOURCE, not from a second list — a duplicate list is
      the very thing that lets a new command slip through — and it also fails on a classification
      left behind for a command that no longer exists.
- [x] Commands NOT on a harness hot path are exempt, and the exemption is written down per command —
      a blanket exemption list with no reasons rots into "everything is exempt". Enforced: a reason
      shorter than a sentence fails the test.
- [x] The paired stdout invariant is asserted too: a hot-path command that exits early must still
      deliver output larger than the ~64 KiB pipe buffer intact. Asserted on `exitNow` ITSELF rather
      than per command, so it covers every command that exits through it, including ones added later
      (the end-to-end proof for `gate` already exists in `hookScripts.test.ts` and is left alone).

## Deliberately NOT in scope

Making the commands faster in the happy path. This is about the ceiling under failure, which is
where the harness is exposed: a slow render is annoying, a 10 s stall per tool call is not usable.

## Note for whoever picks this up

The two requirements pull in OPPOSITE directions — exiting early bounds the hang and truncates the
output; waiting for the flush completes the output and restores the hang. Assert both, and verify
each assertion against its own wrong version. A test that passes against either mistake guards
neither, which is how the truncation half was caught at all.

Reference: `~/.claude/plugins/data/ai-maestro-janitor-ai-maestro-plugins/memory/timeout-bounds-the-request-not-the-process.md`.

## Approval log

- 2026-08-14T02:30:00+0200 — COMPLETED (human_review → complete). Reviewed under the owner's
  standing delegation ("review them yourself... based on verified facts"): every load-bearing claim
  verified first-hand against current code with file:line evidence — see
  reports/trdd-review/20260814_120000+0200-batch1-review.md (this card's section). No contradiction
  found; open residuals, where any, are recorded in that report and are non-blocking.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/cli/cliCore.ts:79 exports `CONNECT_TIMEOUT_MS` (env `AGENTLENS_CONNECT_TIMEOUT_MS`)
  and src/test/cliHotPathLatency.test.ts exists on disk.
