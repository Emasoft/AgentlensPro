---
trdd-id: VNKPUAY4
title: A CLI verb answering whether one model's own weekly window is spent, so an agent can decide before spawning the advisor
column: complete
created: 2026-08-29T11:22:01+0200
updated: 2026-11-17T19:48:58+0100
current-owner: main-session
task-type: feature
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: []
status: archived
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T19:48:58+0100
---

# `agentlenspro model-headroom <model>`

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

- **USER-requested**, 2026-08-29, verbatim: *"add to the agentlenspro cli a new command to check
  if fable or other special models with a separate 7d window are used up or not. so the agents can
  call that one liner from the cli and decide if the advisor can be called or not."*
- Implemented: `src/cli/modelHeadroomCli.ts`, wired in `src/cli/main.ts` (import, `MANAGEMENT_VERBS`,
  dispatch case). `tsc --noEmit` clean.
- **NEXT ACTION**: a unit test over `verdictFor` / `bucketMatches` (both are pure and exported
  precisely so they can be tested without a credential), then run it. Not yet written.
- Second USER request in the same exchange, DONE: `~/.claude/rules/advisor-rules.md` now opens with
  a mandatory STEP 0 naming the exact command and the exit-code table.

## Why

Some models are metered by a weekly window **separate from `weekly_all`** — Fable is one. The
aggregate cannot answer "can I call Fable right now": at `weekly_all` 37% and Fable 100% the
account looks healthy and the advisor is nonetheless unreachable.

**Measured cost of not having this, 2026-08-29.** The user had said Fable's window was used up. I
spawned `fable-advisor:advisor` anyway and waited ~20 minutes for a verdict that could never
arrive, then had to proceed without one. The fact existed only in the conversation, so there was
nothing an agent could branch on — which is exactly what a one-liner fixes.

## Contract

The interface is the **exit code**; stdout is one word so a shell can branch on either.

| exit | stdout | meaning |
| --- | --- | --- |
| 0 | `ok` | headroom remains — callable |
| 1 | `exhausted` | at/above `EXHAUSTED_PCT` (95) of that model's own weekly window |
| 2 | `unknown` | could NOT be determined |

```bash
agentlenspro model-headroom fable -q && <consult advisor> || <skip>
```

`--json` gives the bucket label, percent and reason.

## Design notes that are load-bearing

- **Reuses `officialBuckets(u, '7d')`** (budgetCli.ts), which ALREADY separates per-model weekly
  buckets and names them by `scopeLabel`. No new parsing was added — the distinction this verb
  needs was already modelled, it just had no CLI surface.
- **`unknown` is never coerced to `ok`.** A model with no matching weekly bucket may genuinely be
  metered only by `weekly_all`, OR the payload may not report it, OR the name may be mistyped —
  indistinguishable here. Guessing `ok` would reintroduce the exact failure the verb prevents.
  This matches the existing sibling contract (`cache-expired` "never prints `false` for a question
  it could not resolve").
- **95, not 100.** A window at 99% has no useful room; a caller that squeezes in gets a mid-flight
  rate-limit instead of a clean "pick another model" up front.
- **The advisor rule treats exit 2 as PROCEED**, not skip — an unreadable credential must not
  silently disable consultation forever.

## Acceptance

- [x] `verdictFor(null, 'fable')` -> `unknown` (no payload is not `ok`).
- [x] A payload with a `weekly_scoped` bucket labelled for the model at >=95% -> `exhausted`.
- [x] The same bucket below 95% -> `ok`.
- [x] A payload with only `weekly_all` -> `unknown`, NOT `ok`.
- [x] `bucketMatches('claude-fable-5', 'fable')` is true; a different model's label is false.
- [x] `tsc --noEmit` clean.

## Approval log

- 2026-11-17T19:48:58+0100 — COMPLETE by main-agent@agentlenspro. closing edit of a completion recorded on 2026-08-29 with five boxes open: the five boxes are the cases of src/test/modelHeadroom.test.ts (in the tree since commit 83b96f3f; file read whole by the main agent on 2026-11-17): null payload unknown, scoped bucket at the threshold exhausted, below it ok, weekly_all only unknown, bucketMatches true and false. Run on 2026-11-17 as one test file after pnpm run compile-tests (exit 0): mocha --no-config --ui tdd, 9 passing, exit 0. The STATE line 'Not yet written' is older than that commit. Full suite not run.
