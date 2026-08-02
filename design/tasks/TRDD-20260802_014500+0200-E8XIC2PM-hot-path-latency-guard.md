---
trdd-id: E8XIC2PM
title: A latency guard for every CLI command a harness runs on its hot path
column: todo
created: 2026-08-02T01:45:00+0200
updated: 2026-08-02T01:45:00+0200
current-owner: unassigned
task-type: infra
npt: []
eht: []
---

# A latency guard for every CLI command a harness runs on its hot path

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

- [ ] One table-driven test asserting a wall-clock ceiling for every subcommand classified
      `hot-path`, run against an address that **DROPS** (`10.255.255.1`), not a closed port.
- [ ] The classification lives beside the dispatch in `src/cli/main.ts`, so adding a subcommand
      forces a decision rather than defaulting silently into the untested set.
- [ ] Commands NOT on a harness hot path are exempt, and the exemption is written down per command —
      a blanket exemption list with no reasons rots into "everything is exempt".
- [ ] The paired stdout invariant is asserted too: a hot-path command that exits early must still
      deliver output larger than the ~64 KiB pipe buffer intact. `gate` writes the verdict Claude
      Code reads to block a tool call, so truncation there is a corrupted safety decision, and small
      outputs fit in one buffer and hide it.

## Deliberately NOT in scope

Making the commands faster in the happy path. This is about the ceiling under failure, which is
where the harness is exposed: a slow render is annoying, a 10 s stall per tool call is not usable.

## Note for whoever picks this up

The two requirements pull in OPPOSITE directions — exiting early bounds the hang and truncates the
output; waiting for the flush completes the output and restores the hang. Assert both, and verify
each assertion against its own wrong version. A test that passes against either mistake guards
neither, which is how the truncation half was caught at all.

Reference: `~/.claude/plugins/data/ai-maestro-janitor-ai-maestro-plugins/memory/timeout-bounds-the-request-not-the-process.md`.
