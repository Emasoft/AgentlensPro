---
trdd-id: 4BZPAQWM
title: pnpm run compile is red on main — store-opener caps exceeded, and they may only go down
column: todo
created: 2026-09-08T12:36:26+0200
updated: 2026-09-08T12:36:26+0200
current-owner: main-session
task-type: bugfix
scope: project
min-approval-requirement: none
---

# `pnpm run compile` is red on main — store-opener caps exceeded

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

MEASURED on main, 2026-09-08. Not fixed, not investigated beyond the failure text. NEXT ACTION:
find which files added store openers (`git log -S` on the opener call the guard counts), then
either remove them or take the guard's own escape — but the caps may only go DOWN, so raising
them is not the fix.

## The failure

```
$ pnpm run compile
check-duckdb-only: FAIL — non-test opener cap exceeded: 24 > 22.
check-duckdb-only: FAIL — test opener cap exceeded: 15 > 14.
```

`compile` chains `check-types && lint && check-mirrors && check-single-expansion &&
check-duckdb-only && …`, so everything after `check-duckdb-only` never runs — including
`check-identities`, `check-guards`, `check-dist-contents` and the esbuild bundle.

## Why this is urgent rather than annoying

- **`compile` is on the CI and publish path.** A red `compile` means the release path is red.
- **The caps are a stated invariant that moves in one direction only.** The guard's own text says
  they may only go DOWN. Exceeding them by 2 and 1 means someone added store openers, so this is a
  live regression against a declared rule, not a flaky threshold.
- **The gates that never run are the ones that protect identities and tarball contents.**
  `check-identities` (no personal email or home path in tracked or shipped files) and
  `check-dist-contents` (the npm tarball allowlist) are downstream of the failing link. While
  `compile` is red, those two are not running locally at all.

## How this was found, and the process defect that goes with it

Found incidentally while landing TRDD-DRH4ZRGB's message fix, and then **named as needing its own
card in three places — two commit bodies and a section of DRH4ZRGB — and carded zero times.**

That is worse than not noticing. Anyone auditing open work greps columns or issues and finds
nothing; anyone reading commit bodies finds three mentions and concludes it is handled. Not
noticing leaves a red gate; noticing repeatedly without filing leaves a red gate plus a paper
trail that suppresses the next person's alarm. This card exists to end that.

## What is NOT established

- **Which change added the openers.** Not investigated.
- **Whether the additions are legitimate.** A new file that genuinely needs its own store handle
  is a different problem from a file that should have reused an existing entry point — the guard's
  own text says a new test opening its own handle should first ask whether it can use the same
  entry point the product uses.
- **Whether `main` was ever green with these caps.** Unknown; the caps may have been tightened
  after the openers landed.

## Adjacent, and also uninvestigated: 6 failing tests

`npx mocha` on the full suite: 2684 passing, **6 failing** — all in `cacheBreakTimeline` and a
`standalone server — P5 window auto-calibration` suite, one reporting `store holds 0 span(s)
across 0 segment(s)`. They were dismissed once as "pre-existing and unrelated" **on the strength
of their names**, which is a proxy read. The discriminator run intended to settle it did not:
`.mocharc`'s `spec` overrode the positional file arguments so it re-ran the whole suite, and it
was SIGKILLed at the 900 s timeout (`exit=137`). Neither isolated nor completed.

Recorded here rather than in a fourth commit body. Whether it belongs to this card or its own is
a judgement for whoever picks this up; both touch the store.

## Acceptance

- [ ] The commit(s) that pushed the opener counts over the caps are identified by SHA.
- [ ] Each added opener is classified: reuses an existing entry point, or genuinely needs its own.
- [ ] `pnpm run compile` exits 0 on `main` **without** raising either cap.
- [ ] The 6 suite failures are either shown pre-existing by an actually-isolated run, or carded.
