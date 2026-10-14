---
trdd-id: CS2W7E77
title: The five P5 window auto-calibration tests fail deterministically on a burn-config ENOENT
column: todo
created: 2026-09-04T14:22:35+0200
updated: 2026-10-14T23:26:27+0200
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

**A false root cause I PUBLISHED and then retracted one message later — recorded honestly, because
an earlier draft of this paragraph called it a "near-miss", which claimed more credit than the
sequence supports.** What actually happened: `ls -la standalone/*.js` showed only `cli.js`, and I
immediately wrote, to the user, *"Root cause found, and it's definitive — not a hypothesis."* It
was neither. I kept investigating, hit the contradiction (2,652 tests passing, a dozen suites
booting the same "missing" file), and retracted it in the next message.

So this is not an example of catching an error before asserting it. It is an example of asserting
first and being rescued by a number that happened to already be in hand. Had the suite been smaller,
or had I not had the passing count in front of me, "server.js is missing" would have been committed
into this card as its established root cause, and it is wrong. **The word "definitive" is the
defect** — the measurement (`ls`) was sound; the certainty attached to it was not, and nothing
about a single directory listing licensed the leap to a five-step causal chain.

## Candidate causes, none yet tested

- The P5 window auto-calibration was never ported to Rust in the TRDD-1B98LCVR rewrite — i.e. a
  missed EHT of that card, and a genuine PRODUCT gap rather than a fixture defect.
- ~~The `alcore` binary under test is STALE relative to `rust-core/` source.~~ **ELIMINATED
  2026-09-04 by measurement.** `alcoreTestBin()` (`freePort.ts:150-177`) returns the first
  EXECUTABLE candidate, which here is `rust-core/target/release/alcore` — built **08:54:18**, while
  the newest `.rs` under `rust-core/crates` is **08:31:39**. The binary post-dates every source
  file, so the tests are not running old code.
  Checked two independent ways on purpose: `find -newer` returned 0 files, and a `stat -c %Y` epoch
  comparison agreed. The corroboration is not ceremony — a LOCAL memory note records that `find` on
  this machine is **bfs, not GNU find**, and that its time predicates can return the OPPOSITE
  answer, so a bare `find -newer` result is not by itself evidence here.
  (This does NOT contradict "TRDD-QE114936 is committed but not deployed": that concerns the LIVE
  server process and the `bin-native/` copy the installed CLI spawns, not the binary this suite
  resolves.)
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
2026-09-24T08:56:26+0200 — from superseded/duplicate TRDD-XI3UZUTK (same 5 P5 failures, same suite): the boot log showed "file watching unavailable ... falling back to a 5s full poll" — supports the timing/race hypothesis (5s poll interval racing a tighter test timeout) named as the leading candidate cause here.

## Release-gate runs (2026-10-14)

Run 1: HEAD ed0fbd5e plus the uncommitted TRDD-QQ2XIIZ6 card edit (committed afterwards as 4685acfe); node esbuild.js exit 0; pnpm run test:unit exit 0, 3165 passing, 14 pending, 0 failing (9 min).
Run 2: HEAD 4685acfe; pnpm run test:unit exit 2, 3163 passing, 14 pending, 2 failing (12 min). Both failures were mocha 10 s timeouts in cliDispatch.test.js: "`list --definitely-not-a-real-flag` exits 64" (286 ms in run 1) and "a tool-level refusal exits non-zero" (1874 ms in run 1).
Both runs used the working tree, not a clean checkout: it carries the owner-pending AGENT_NAMES hunk in src/cli/hookInstall.ts and the untracked agents/cheap-worker.md, agents/fast-worker.md and agents/smart-worker.md (plus unrelated dirty docs, cards and memory pages). A run counts toward this gate only if the release ships exactly the tree it ran on.
Run 2 cause, settled from the log: a machine-wide starvation window of about 85 s. 23 consecutive spawned-CLI tests slowed 3-40x, including --version, -v and --help, which contact neither the in-process MCP stub nor any server (-v 238 ms to 9432 ms); the run recovered afterwards. Load average at the time was 195-267, from external machine load, none of it test processes. Not a stub stall, not a live-server stall. Re-run in isolation under the same load, the two tests took at most 487 ms and 2604 ms.
Found while triaging: cliDispatch test 2 ran the first-run launch setup on the default ports 3000/4316/4318, the live collector's, and setup's server step can SIGTERM a server whose data dir differs (TRDD-V2HFI30L). Mitigated on the test side (a port taken first by another process is still exposed until TRDD-V2HFI30L lands): test 2 now pins three free ports and pre-sets the revive brake in its own data dir, asserting the first-run-failed notice, no server.pid and no surviving alcore. Three of the four spawning suites in cliDispatch.test.ts run under a 60 s ceiling instead of mocha's 10 s default (the network-help suite's single test keeps its own 30 s); all assertions unchanged.
The count of two consecutive green full-suite runs restarts after the cliDispatch test fix lands; the product fix in TRDD-V2HFI30L restarts it again when it lands.
Run A1: HEAD 29ec567a; exit 2, 3169 passing, 14 pending, 2 failing at load average about 300: hookScripts 'a server that HANGS' (5444 ms against an absolute 5 s bound) and logReader.fileMetaCache 'exactly ONE directory walk' (got 2). Both were load-sensitive tests, not product defects; fixed in 0bb935cb (a control-relative bound; the walk memo held fresh in the test).
Run B1: HEAD 0bb935cb; exit 0, 3171 passing, 14 pending, 0 failing. The CLI hot-path latency guard SKIPPED (machine 4.6x oversubscribed, limit 2x).
Run B2: HEAD 0bb935cb; exit 1, 3171 passing, 13 pending, 1 failing. The latency guard RAN for the first time today and caught a real defect: cache-expired was not excluded from the launch self-heal, so it ran a full first-run setup (1590 ms against a 1500 ms ceiling). Fixed in 42017224.
Gate rule added 2026-10-14: the latency guard skips whenever load average / CPUs > 2, which held in every run today except B2. So a green pair counts only if at least one of its two runs actually EXECUTED the hot-path latency guard (its log shows the test passing, not a SKIPPED line). Each run also records its HEAD and the dirty working-tree files it ran with.
