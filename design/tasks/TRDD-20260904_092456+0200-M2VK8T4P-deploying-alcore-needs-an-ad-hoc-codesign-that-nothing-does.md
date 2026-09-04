---
trdd-id: M2VK8T4P
title: Deploying alcore needs an ad-hoc codesign that no script performs
column: todo
created: 2026-09-04T09:24:56+0200
updated: 2026-09-04T09:24:56+0200
current-owner: main-session
task-type: infra
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [deploy, macos, packaging]
priority: high
severity: high
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# Deploying alcore needs an ad-hoc codesign that no script performs

## What happened (measured 2026-09-04, cost a downed server)

Deploying the Rust core the documented way — `cargo build --release`, copy into
`bin-native/darwin-arm64/`, `agentlenspro server restart` — **killed the running server and the new
binary would not start.** Sequence:

1. `agentlenspro server restart` → `server stopped (pid 52561)` then
   `FAIL: the server exited during startup — it never answered.`
2. Nothing in `~/.agentlens/server.log` (the process died before it could log).
3. Running the binary directly: `./bin-native/darwin-arm64/alcore --version` → **exit 137**.

**137 is 128+9 = SIGKILL**, and the process died before `main` — no error, no log line, no stderr.
The usual cause on Apple Silicon is a missing or invalid code signature, and that is the working
hypothesis. **It is NOT established.** What was measured is only: exit 137 before, runs after.
The genuine competitor: the `cp` wrote over a binary that was RUNNING and mapped, leaving a stale
cached verdict against the replaced file — and `codesign --force` fixes that too, by rewriting it.
Both stories predict exactly what was seen.

**ORDERING MATTERS AND IS EASY TO MISREAD, so it is recorded here:** the copy came FIRST, while the
old server was still up; `server restart` ran afterwards and printed `server stopped (pid 52561)`,
which is itself the proof that 52561 was alive — and therefore mapped — at copy time. A review of
this card read the sequence the other way round and concluded the stale-mapping story had no
premise. It does. This does not make it the cause; it means the evidence does not rule it out. (Quarantine is NOT a candidate: `codesign`
does not touch xattrs, and quarantine produces a Gatekeeper prompt or EPERM, not a silent SIGKILL.)

Three commands would settle it, none of them run:
- `codesign -dv --verbose=4 <binary>` on a FRESH `cargo build` output, before any copy — if cargo
  already ad-hoc signed it, the unsigned hypothesis dies outright.
- `codesign --verify --verbose` on the copied-but-not-yet-re-signed binary.
- Reproduce with `rm` + `cp` instead of `cp` over the live file.

No `reports/` artifact was written for this incident; the narrative here and the CLAUDE.md bullet
are the whole record.
The fix was one command:

```
codesign -s - --force bin-native/darwin-arm64/alcore
```

after which the binary ran and `server restart` succeeded (pid 37180).

## Why this is worth a card

**The failure presents as a code bug.** `server restart`'s message — "the server exited during
startup — it never answered" — reads as a crash in our own startup path. The actual cause is a
platform signature check that never entered our process. Someone without the exit-137 clue will
debug the server, not the signature. That diagnosis is the expensive part, and it is written down
here so the next person does not rediscover it with a downed collector.

**Nothing in the build does it.** Verified 2026-09-04: `grep -rn codesign scripts/ package.json
.github/workflows/` returns NOTHING. So the next `cargo build && cp` reproduces the outage exactly.

## The part that may be bigger than local deploy

`.github/workflows/publish.yml` builds the four platforms' binaries, uploads them as artifacts,
downloads them in the `package` job, `chmod +x`es them, and verifies the mode inside the packed
`.tgz`. **Mode is not signature.** If a macOS binary reaches a user's machine unsigned or with a
signature invalidated by the artifact round-trip, it dies the same way — SIGKILL at spawn, and
`src/rustBinResolve.ts` falls back to the TS server, so the user silently gets the slow path and
never learns why.

**This is UNVERIFIED and must be checked before assuming a shipping bug exists.** `cargo build`
ad-hoc-signs on Apple Silicon by default, so published binaries may be fine and this may be purely a
local-copy artifact. What is certain is only the local failure above. Do not file a shipping bug on
this card's word — measure first.

## What to do

- [ ] Determine WHY the copy lost its signature (cargo ad-hoc signs by default; establish whether
      the loss came from the `cp` over a running/mapped binary, or the artifact round-trip, or
      something else). The remedy depends on the cause.
- [ ] Put the signing step wherever binaries are placed for execution, so the documented deploy path
      cannot produce a dead server.
- [ ] Check the published tarball on a clean macOS machine: does its `alcore` spawn, or does
      `rustBinResolve` silently fall back? That single observation settles the shipping question.
- [ ] Record the exit-137 diagnosis in the deploy docs — the symptom is indistinguishable from a
      startup crash without it.

## Notes

`bin-native/` is untracked (gitignored build output, correct per RULE 0), so there is no recorded
link between the running binary and a commit. The live `alcore` as of 2026-09-04 09:00 is the tree
at 08:54, equivalent to `7a4810e1`; the only rollback copy is `/tmp/alcore.rollback.085452`, which
will not survive a reboot.
