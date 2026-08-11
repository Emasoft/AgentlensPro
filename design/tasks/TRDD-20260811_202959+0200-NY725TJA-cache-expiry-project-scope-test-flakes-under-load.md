---
trdd-id: NY725TJA
title: The cacheExpiry project-scope test flakes under full-suite load and has never been root-caused
column: todo
created: 2026-08-11T20:29:59+0200
updated: 2026-08-11T20:29:59+0200
current-owner: main
task-type: bugfix
severity: medium
---

# The cacheExpiry project-scope test flakes under full-suite load and has never been root-caused

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-11

Not started. Carded because it has now surfaced three separate times tonight and each time was
waved off as "a known flake" — which is how a real defect becomes permanent furniture. Nobody has
ever established the mechanism.

**NEXT ACTION:** reproduce it deliberately under load and capture the ACTUAL assertion values (see
*How to reproduce* below). Do not attempt a fix before the mechanism is known — a timing-looking
failure with an unread assertion is exactly the shape that gets "fixed" by widening a timeout that
was never the cause.

## The failure

```
1) handleCheckCacheExpiry — project scope (2026-08-04)
     an empty project string is the documented machine-wide opt-out, and --all is scoped too
```

Test file: `src/test/cacheExpiry.test.ts`.

## Measured, on IDENTICAL code (commit 942d5ac's tree)

| run | result |
|---|---|
| full suite | 2226 passing / **1 failing** |
| full suite | 2225 passing / **2 failing** |
| full suite | 2227 passing / **0 failing** |

So it is genuinely non-deterministic, and the failure COUNT varies too — which means more than one
case in that suite is exposed, not just the named one. An earlier sighting tonight reported a
`'mine' !== 'foreign'` mismatch, i.e. the project-scoping resolved to the wrong project, not a
timeout. **That detail matters and points away from "slow machine":** a timeout produces a timeout
error, not a wrong-value assertion.

Every observation so far was on a heavily contended box (load 60-150 on 14 CPUs, ~20 concurrent
Claude sessions). The correlation with load is real but is NOT itself the mechanism.

## Two hypotheses, neither confirmed

1. **Shared mutable state across the suite.** `.mocharc` runs every test in ONE process
   (`spec: ['out/test/test/**/*.test.js']`), so a module-level cache, a registry, or a cwd/env
   mutation set by another test file could leak in. Test ORDER under load is the only thing that
   changes between a green and a red run — which fits a leak far better than it fits timing.
2. **A real cwd/project-resolution race.** The test asserts project SCOPING; if resolution reads
   the live cwd or a shared project map that another concurrent test mutates, `'mine' !== 'foreign'`
   is exactly what you would see.

Hypothesis 1 is the cheaper one to falsify and should go first.

## How to reproduce

Note that a positional file does NOT isolate — `.mocharc`'s `spec` glob is ADDED to it, so
`npx mocha out/test/test/cacheExpiry.test.js` still runs the whole suite (~2237 tests). Use
`--spec` or `--grep` for genuine isolation:

```bash
npx mocha --spec out/test/test/cacheExpiry.test.js          # this file alone
npx mocha --grep "machine-wide opt-out"                     # the one case, full-suite context
```

Run the full suite in a loop until it reddens, and capture the assertion's ACTUAL value, not just
the pass/fail. If it passes under `--spec` but fails in the full suite, hypothesis 1 is confirmed
and the leaking test is findable by bisecting the file list.

## Verification

A fix is only proven by the full suite green across **at least 10 consecutive runs under load
comparable to where it fails** (load ratio > 4 on this box). One green run proves nothing — the
measured distribution above already contains a green run on the failing code.

Do NOT "fix" this by adding a retry, widening a timeout, or marking the test pending. A wrong-value
assertion is not a timing problem, and hiding it would remove the only signal that the scoping
logic misbehaves under concurrency — which, if hypothesis 2 holds, is a PRODUCT bug and not a test
bug at all.

## Notes and lessons learned
