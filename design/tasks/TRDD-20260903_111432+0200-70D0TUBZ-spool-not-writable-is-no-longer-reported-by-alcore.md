---
trdd-id: 70D0TUBZ
title: alcore does not report a non-writable bodies sink so server status can never show the SINK clause
column: todo
created: 2026-09-03T11:14:32+0200
updated: 2026-09-03T11:14:32+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
created-by: main-session
npt: []
eht: []
relevant-rules: []
---

## Symptom

`src/cli/serverControl.ts:514,524,583` still renders a `SINK: <reason>` clause in
`agentlenspro server status` from a `sinkProblem` field on the server-stats response — but
`agentlenspro server status` can never show that clause today, because nothing on the alcore
side ever sets it. Verified:

```
rg -n "sink_problem|sinkProblem" rust-core/crates src/cli/serverControl.ts
```

returns matches ONLY in `serverControl.ts` (the TS render of the CLI response type) — zero
matches anywhere under `rust-core/crates`. alcore's `/api/server-stats` route has no field named
`sink_problem` and no code that probes the bodies-sink directory's writability.

## What the retired TS server did (for reference, not to be resurrected as-is)

The retired `standalone/server.ts` (deleted in commit `567fc5c2`, "alcore is the only backend")
re-probed the bodies-sink directory's writability on every pass tick
(`BODIES_PASS_INTERVAL_MS`: 60s in spool mode, 1h otherwise — see archived TRDD-Z8WJZV8E for the
staleness-window discussion that applies equally here) and cached the result as `sinkProblem` +
an age. That cadence coupling is exactly what Z8WJZV8E flagged as worth reconsidering; this card
is scoped to just restoring the capability in alcore, not to re-litigating the interval.

## Proposed fix

Add a bodies-sink writability probe to alcore's existing server-stats path (wherever `capture:`
live-file counts are already assembled) that:

- attempts a small write (e.g. a `.sink-probe` file) into the configured bodies-sink directory,
- on failure, sets `sink_problem: <error string>` in the stats response,
- on success, sets it absent/null,
- includes `sink_probed_at_ms` so a client can show the value's age (per TRDD-Z8WJZV8E's
  acceptance criteria — the served value should carry its age, not just a boolean).

Per TRDD-7YPQWKPG's no-resident-data-model rule: keep no state beyond the ephemeral probe result
of the current call/tick — do not add a new resident cache field that must be kept in sync.

## Acceptance

- [ ] `server-stats` (or equivalent alcore route) emits `sink_problem` + `sink_probed_at_ms`
      when the configured bodies-sink directory is not writable.
- [ ] Real test: create a temp data dir, make its bodies-sink subdirectory read-only
      (`chmod 555` or platform equivalent), call the stats route, assert the clause is present
      with a fresh `sink_probed_at_ms`.
- [ ] Same test, restore write permission, call again, assert the clause is absent/cleared.
- [ ] `agentlenspro server status` renders the restored clause end-to-end against a live
      alcore instance (not just the CLI's existing render logic, which already works).

## Not in scope

Re-deciding the probe cadence (1h vs shorter) — that discussion lives in archived TRDD-Z8WJZV8E
and can be revisited once the field exists again to have a cadence at all.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

**NEXT ACTION:** implement the sink-writability probe in the alcore server-stats route
(rust-core), wire `sink_problem`/`sink_probed_at_ms` into the JSON response, then verify the CLI
render at `src/cli/serverControl.ts:514-524` picks it up unchanged (it already expects this
shape).

## Approval log

