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

**A plausible ordering is: no spans land in the isolated store → no account window exists → the
calibration never runs → `burn-config.json` is never written → the other four ENOENT.** That is a
HYPOTHESIS, not a reading of the errors: the messages give two endpoints (an empty store, a missing
file), and the arrow between them is inferred. It is worth pulling first because of ESTABLISHED
fact 1 below, and it must not be assumed while fixing.

Either way the ENOENT is almost certainly downstream. Making `burn-config.json` appear without
asking why the store is empty would produce four green tests that assert nothing.

## What IS established (verified first-hand 2026-09-04, each by reading the source)

1. **All five tests share ONE `suiteSetup`** (`serverCalibration.test.ts:126`), which builds the
   isolated `HOME`/`DATA_DIR` once at `:141`. A single shared root cause is therefore plausible —
   this is what licenses the hypothesis above, and it is the only thing that does.
2. **`standalone/server.js` DOES NOT EXIST, and that is BY DESIGN — do not "fix" it.** The suite
   passes that path to `spawnServerWithRetry`, but `src/test/helpers/freePort.ts:227` treats it as
   a SENTINEL: `isRealServer` regex-matches it and spawns the **Rust `alcore` binary** instead
   (`:232`), because TRDD-1B98LCVR box 4 deleted `standalone/server.ts` and made alcore the only
   server. A missing binary throws; there is no silent fallback.
3. **Therefore these tests exercise the RUST server**, not a TypeScript one.
4. **alcore boots and serves correctly in the same run** — twelve other `standalone server — …
   (real boot)` suites route through that identical line and PASS (verified in the run-B output:
   `hook/gate/burn endpoints`, `Codex log-ingest`, `ACAO`, `gen_ai injection`, and others, all ✔,
   with no skip guard in any of them).
5. **So the defect is specific to the calibration path, not to booting or ingest in general.**

**A near-miss worth recording, because it nearly became this card's stated root cause:** the first
reading of fact 2 was "`server.js` is missing, so the child never starts" — a tidy, complete,
WRONG explanation. It was caught only because it contradicted a number already in hand: 2,652 tests
passed, including a dozen suites that boot the same "missing" file. The contradiction, not the
investigation, is what falsified it.

## Candidate causes, none yet tested

- The P5 window auto-calibration was never ported to Rust in the TRDD-1B98LCVR rewrite — i.e. a
  missed EHT of that card, and a genuine PRODUCT gap rather than a fixture defect.
- The `alcore` binary under test is STALE relative to `rust-core/` source. Note TRDD-QE114936 is
  committed but NOT deployed, and `bin-native/` is gitignored, so the binary has no recorded link
  to a commit. Check what `alcoreTestBin()` resolves to and how old it is BEFORE blaming the code.
- The suiteSetup strips a long list of `AGENTLENS_*` capacity vars (`:152-161`) so an inherited cap
  cannot make calibration refuse to run. If alcore reads a differently-named var, the strip misses
  it and calibration correctly declines — a fixture defect that looks like a product one.

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

- [ ] Determine whether the five failures share ONE cause or five. The shared `suiteSetup` makes one
      likely but does not prove it. Tickable either way — this box asks a question, it does not
      presuppose the answer. (Reworded 2026-09-04: it previously read "the root cause of the empty
      span store is identified", which PRESUPPOSED the hypothesised chain, so an implementer who
      found four independent causes could not have ticked it without arguing with the card. That is
      the same defect as the load-average option on TRDD-2R0AXCKL — an unproven cause hardening
      into an acceptance criterion.)
- [ ] Whether this is a product defect (calibration not ported to Rust) or a fixture defect (stale
      binary, missed env var) is decided and recorded. Both are legitimate outcomes; an un-decided
      "it's probably the fixture" is not.
- [ ] All five tests pass, or any that are mis-specified are rewritten to assert the real
      behaviour. A test deleted to make a gate green does not satisfy this box.
- [ ] Two consecutive full-suite runs show zero `P5 window auto-calibration` failures.

## Notes and lessons learned
