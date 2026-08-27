---
trdd-id: YBJGIYI1
title: FORK_STORM cannot be distinguished from one fat session rewriting its own prefix
column: todo
created: 2026-08-27T22:50:06+0200
updated: 2026-08-27T22:50:06+0200
current-owner: unassigned
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: DMWOBWFH
min-approval-requirement: none
priority: high
implementation-commits: []
---

# FORK_STORM cannot be distinguished from one fat session rewriting its own prefix

## The defect (VERIFIED at file:line, not relayed)

`src/burnInvestigator.ts:328` classifies a cluster as `FORK_STORM` when
`spikes >= 3 && biggestFam >= 3 && coldSpikes >= 2`, and `biggestFam` comes from:

```ts
// src/burnInvestigator.ts:304-306
const fams = new Map<string, number>()
for (const r of nearby) fams.set(r.fingerprint, (fams.get(r.fingerprint) ?? 0) + 1)
const biggestFam = Math.max(0, ...fams.values())
```

It counts **requests per transcript fingerprint**. `ReqRec` (line 107) is
`{ts, size, model, workspace, fingerprint, imageBytes}` — it carries **no session id and no
agent id**, and `fingerprint` is a djb2 of the first 2600 chars of the FIRST message
(line 241-243).

Two very different situations therefore produce an identical signature:

| Situation | spikes | fingerprint | classified |
| --- | --- | --- | --- |
| 3 forks of one fat parent | 3 | identical (inherited transcript) | `FORK_STORM` |
| ONE session rewriting its own fat prefix 3× (compaction boundary, model switch, TTL lapse) | 3 | identical (its own first message) | `FORK_STORM` ← **wrong** |

The `else` branch that should catch the second case (`FAT_SESSION_REWRITES`, line 353) is
unreachable for it, because `biggestFam >= 3` matches first.

The verdict string then asserts a cause the evidence cannot support: *"N requests share ONE
inherited transcript: a fan-out forked a fat parent into a cold cache"*. **Sharing a fingerprint
is not evidence of inheritance** — a session shares a fingerprint with its own earlier self.

## Why it matters (the remedies are opposite)

- `FORK_STORM` → *stop the fan-out.*
- `FAT_SESSION_REWRITES` → *`/compact` the session* — which is itself a cold rewrite, i.e. the
  exactly wrong move if the real cause were a fork storm, and vice versa.

An attribution that names the wrong one sends the operator to the more expensive fix.

## Corroboration

- **A peer session (ai-maestro-30, 2026-08-27) reported** `FORK_STORM` / `PREMIUM_MODEL_FANOUT`
  named twice for what it measured as a fat main context past its compaction point — *"process
  age spread ≥3h, zero spawns"*. Magnitude right, cause label wrong. That report is a peer's
  measurement, not verified here; the code path above IS verified here and predicts exactly it.
- **This session's own earlier `FORK_STORM` verdict is now UNVERIFIED in both directions.** The
  magnitude stands (7 fully-cold full-prefix writes in 11 min, window $73.71 — those are read
  from usage, not inferred). Review forks WERE spawned in that window, so a genuine storm is
  plausible; but the heuristic could not have told the difference, so the label was not earned.

## The fix — in RUST, not TypeScript

`min-approval-requirement: none`, but it is **deliberately not being fixed in
`src/burnInvestigator.ts`**: the USER's ruling on [[TRDD-DMWOBWFH]] box 3 is *delete the TS
core, TypeScript for the web UI only*. The port already exists at
`rust-core/crates/agentlens-core/src/burn/investigator.rs`, with a parity fixture at
`tests/fixtures/burnscan-expected.json` — so a TS fix would have to be mirrored into Rust and
then deleted.

Sketch of the discriminator:

1. Carry a **session/agent identity** on the per-request record alongside `fingerprint`. The
   capture already has it elsewhere (OTEL `api_request` events carry `session.id` directly —
   see the `get_cache_event_log` note in CLAUDE.md).
2. `FORK_STORM` requires the biggest family to span **≥2 distinct session ids**. One id ⇒
   `FAT_SESSION_REWRITES`, whatever the request count.
3. When identity is unavailable for the window, emit the cluster with the honest cause
   (`FAT_SESSION_REWRITES`, or an explicitly unnamed cluster) rather than the flattering one —
   the standing bar from [[TRDD-B9ERTBZ9]] is that a cause is named only when it can be told
   apart from its alternatives.
4. Update `burnscan-expected.json` and add a fixture case for the one-session-many-rewrites
   shape, which is what nothing currently pins.

## Verify

A fixture with 3 cold full-prefix spikes, one fingerprint, ONE session id must classify as
`FAT_SESSION_REWRITES`; the same shape across ≥2 session ids must classify as `FORK_STORM`.

## Approval log

- 2026-08-27T22:50:06+0200 — Filed from a peer report, then confirmed first-hand at
  `src/burnInvestigator.ts:304-306`, `:328`, `:107`. Queued to `todo`, not started: it is Rust
  cutover work and the USER's sequencing is publish → install → Rust.
