---
trdd-id: CS2W7E77
title: The five P5 window auto-calibration tests fail deterministically on a burn-config ENOENT
column: todo
created: 2026-09-04T14:22:35+0200
updated: 2026-09-04T14:22:35+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
min-approval-requirement: none
created-by: main-session
npt: []
eht: []
blocked-by: []
---

# The five P5 window auto-calibration tests fail deterministically

## Symptom

`standalone server — P5 window auto-calibration (real boot, real ingest path)` fails all five of
its tests, in **every** run:

- a rate-limit StopFailure through the ingest path writes observed capacity to `burn-config.json`
- a second replay with LOWER consumption does not lower the observed capacity
- a natural 5h window rollover does not calibrate
- a non-rate-limit StopFailure does not calibrate
- user-configured capacity is never overwritten by a later stall

Four fail on the same error, which is the thread to pull:

```
Error: ENOENT: no such file or directory, open
  '/var/folders/.../al-cal-srv-XXXXXX/home/.agentlens/burn-config.json'
```

The fifth fails earlier and differently, and its message contains the actual diagnosis:

```
AssertionError: account window must exist before the stall. accounts: ... 0 span(s) (last 24h
window) from .../data/spans — store holds 0 span(s) across 0 segment(s), nothing evicted
```

So the ordering is: **no spans ever land in the isolated store → no account window exists → the
calibration never runs → `burn-config.json` is never written → the other four ENOENT.** The ENOENT
is the symptom; the empty span store is the defect. Fixing the file-not-found without asking why
the store is empty would produce four green tests that assert nothing.

## Why this card exists (and why it is not TRDD-2R0AXCKL)

Measured 2026-09-04 across two full-suite runs on one tree: run A had 15 failures, run B had 8.
These five failed in **both** — they are DETERMINISTIC, unlike the flipping clusters. TRDD-2R0AXCKL
covers tests that cannot make up their mind; its acceptance is explicitly a *determinism* bar
("same verdict", not green), so these five satisfy that card while remaining broken.

That is exactly why this card had to exist. On 2026-09-04 TRDD-2R0AXCKL was edited to name these
five and disown them ("not this card's class at all") and nothing was filed. Before that edit they
were ambient — nobody's, but undisclaimed. After it, the only card that named them formally
excluded them, so 2R0AXCKL could close, HSPUF5XH's `blocked-by` could drain, and **no card on the
board would assert that the suite passes.** Disowning without rehoming is worse than silence: it
launders a known failure into an explicitly-someone-else's-problem that is nobody's. Filed as the
handoff that edit owed.

## Prior art to check before investigating

- The suite is `serverCalibration.test.ts`, which was ALREADY failing 0-passing/5-failing on a
  clean HEAD in an isolated worktree earlier in this session — so it is **pre-existing, not a
  regression** from any 2026-09-04 commit. Confirm that independently before assuming it.
- The test builds an isolated `HOME` and `DATA_DIR` under a temp dir. Per CLAUDE.md, isolation
  requires its own `DATA_DIR` **and** `HOME`; ports alone do not isolate. Check the fixture
  actually sets both, and that the live server on this machine is not the one being measured.
- `agentlenspro setup` / the collector may need to be reachable for spans to land; if the fixture
  depends on a live OTLP listener that is not started, the empty store is expected and the test is
  mis-specified rather than the code broken.

## Acceptance

- [ ] The root cause of the empty span store is identified and stated — NOT the ENOENT, which is
      downstream of it.
- [ ] Whether this is a product defect or a test-fixture defect is decided and recorded. Both are
      legitimate outcomes; an un-decided "it's probably the fixture" is not.
- [ ] All five tests pass, or any that are mis-specified are rewritten to assert the real
      behaviour. A test deleted to make a gate green does not satisfy this box.
- [ ] Two consecutive full-suite runs show zero `P5 window auto-calibration` failures.

## Notes and lessons learned
