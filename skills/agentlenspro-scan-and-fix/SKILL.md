---
name: agentlenspro-scan-and-fix
description: Scan a codebase for errors and fix them with a token-calibrated agent fleet. Covers the DYNAMIC half that linters cannot see — failing tests, CI failures, flakes — with a flake gate that classifies before diagnosing, signature clustering so one root cause is one worker, and a serial fix lane because test verifiers are global. Ships a Workflow template to customize. Use when asked to scan and fix errors, fix failing tests, fix a red CI, or hunt flaky tests.
---

# Scan and fix errors — the dynamic lane

Linters see what is wrong in the source. This covers what is only wrong **when it runs**: a
failing test, a red CI job, a flake. Those need a different shape, because their verifier is the
whole tree, not one file.

## The economics that decide the shape (measured 2026-08-14, 7 agents, one repo)

**An agent launch costs ~118k tokens before it does anything.** Measured directly: a worker that
read one file, decided no change was needed, and stopped still spent **117,663** tokens. That is
the boot floor — CLAUDE.md, rules, tool schemas — and everything else is noise beside it.

| Variant | Tokens/file | vs merged |
|---|---|---|
| merged find+fix, 1 worker | 120,454 avg | 1.00× |
| split reader → fixer | 246,855 | **2.05×** |
| merged, `tldr`-only reads | 122,529 | 1.02× |

Three consequences, and the second one is counter-intuitive:

1. **Never split reader and fixer.** It buys nothing and pays the floor twice.
2. **Reading less barely helps on small files.** The `tldr`-only worker read 170 lines instead of
   a whole file and came out 2% *worse* — its extra tool calls cost more than the body it saved.
   Byte discipline starts to matter around a thousand lines; below that, ignore it.
3. **The only real lever is fewer launches.** Give one worker a BATCH of files that share a
   collision domain, not one file each. One-file-one-owner is a rule about *write collisions*,
   not about parallelism — one owner can own five files.

## The pipeline

```
S0 COLLECT → S1 CLUSTER → S2 CLASSIFY → S3 STATIC BARRIER → S4 FIX → S5 PROVOKE → S6 SHIP → S7 REPORT
```

**S0 COLLECT (zero-LLM).** Every red signal into one list: the test runner, `gh run view
--log-failed`, gate exit codes. Capture to files; never pipe raw logs into context. Zero red ⇒
stop, no agents.

**S1 CLUSTER by failure signature.** Group by error-message shape + top distinct stack frame +
shared symbol. N red tests from one bug become ONE cluster with ONE owner. Tell the worker to
split the cluster and return the remainder if it turns out to be two bugs.

**S2 CLASSIFY on a 2×2 — never on isolation alone.** Re-run each cluster *in isolation* and *in
a full-suite run*:

| | fails in suite | passes in suite |
|---|---|---|
| **fails alone** | deterministic bug | environment/ordering assumption |
| **passes alone** | order / shared-state / parallelism | flake (timing or resource race) |

Isolation-only testing is blind to the bottom-left cell — the usual CI-vs-local divergence. A
commit that goes green on re-run with **zero changes** is a flake by construction. Root-cause the
nondeterminism *wherever it lives*: "it's intermittent, so fix the test" is false when the race
is in the product.

**S3 STATIC BARRIER.** Get the mechanical scanners clean first (`/wf-check-and-fix` if you have
it). A type error can *be* the cause of the red tests.

**S4 FIX — serial, one worker per cluster.** The verifier is **global**: a linter verifies one
file, a test suite verifies a tree, so two parallel workers cannot verify against a tree the
other is editing. Measured: even `tsc --noEmit` is global — parallel workers read each other's
half-finished edits and each reported errors that were not theirs. Each worker:

1. **Search for an existing owner of this failure mode first** — a helper, a fixture, a prior
   fix. (Earned: a hand-rolled port-retry loop was written while a purpose-built helper for that
   exact race already existed, with two safety properties the copy lacked.)
2. Confirm the claim against code actually read; name the exact input/interleaving that fails.
3. Minimal root-cause fix + one comment saying what constraint makes it necessary.
4. Verify by **running**, and rebuild what the run consumes first (compiled tests, bundles) or
   you are verifying stale artifacts.

**S5 PROVOKE, don't repeat.** N green re-runs cannot prove a 1%-rate race fixed. Ship a
deterministic provocation: pre-bind the port and assert the retry recovers.

**S6 SHIP-PATH VERIFY.** Full gates + full suite, then confirm the change is in the artifact the
user actually runs. Green tests are not a shipped fix.

**S7 REPORT** with honest terminal categories: `fixed` · `not-locally-reproducible (CI-only)` —
reported, never looped through CI by pushing speculative commits · `design-level` → a tracked
task · `residual` with exact `file:line`. No silent caps.

## Hard invariants for every worker

Never reach green by suppression (no ignore comments, no loosened config, no deleted
assertions). Never let a worker run `git`. Two failed attempts at one fix ⇒ stop and report, do
not try a third.

## The template

`templates/scan-and-fix-workflow.js` is a runnable Workflow script with the batching, serial-fix,
and rebuild-before-verify discipline already wired. To customize it:

1. Copy it somewhere writable (it is read-only where it is installed).
2. Fill the `PROJECT` block at the top — the collect commands, the scoped-rerun command, the
   rebuild command, and the gate command for your project. Those five strings are the only
   project-specific part.
3. Set `BATCH` to how many files one worker should own (default 5 — the boot floor is ~118k, so
   batching 5 small files saves ~470k over one-file-one-owner).
4. Run it with the `Workflow` tool, passing the work list as `args`.

The worker agent type it spawns is **`agentlens-tldr-worker`** (shipped alongside; installed into
`~/.claude/agents/`): a merged find-and-fix worker calibrated for this pipeline — it navigates
with `tldr`, reads only the ranges it must reproduce, batches its edits, and verifies in the same
response. Swap the `agentType` if you prefer your own.

`references/measurements.md` has the full A/B run behind the numbers above.
