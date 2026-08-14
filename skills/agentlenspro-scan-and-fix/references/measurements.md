# The A/B run behind this skill's numbers

Measured 2026-08-14 on AgentlensPro. Real work, not a benchmark: migrating 6 mocha suites off a
duplicated `freePort()` helper whose TOCTOU race had reddened CI that morning. Every arm produced
the same output; only the agent architecture differed. All workers: same model, same prompt body,
same verification step.

## Raw

| Arm | Architecture | File | Tokens | Tools | Wall |
|---|---|---|---|---|---|
| A | merged find+fix | standaloneGenAiInject (192 L) | 117,796 | 9 | 52s |
| A | merged find+fix | standaloneCodexIngest (168 L) | 117,133 | 8 | 46s |
| A | merged find+fix | serverCalibration (292 L) | 126,433 | 14 | 74s |
| B | reader (plan only) | serverEndpoints (275 L) | 126,241 | 5 | 65s |
| B | fixer (apply plan) | serverEndpoints | 120,614 | 7 | 38s |
| B | reader (plan only) | standaloneCors (189 L) | 122,001 | 6 | 60s |
| B | fixer (apply plan) | standaloneCors | 119,013 | 7 | 32s |
| B | reader — **no work found** | hookScripts (192 L) | 117,663 | 4 | 14s |
| C | merged, `tldr`-only reads | branchDump (165 L) | 122,529 | 15 | 91s |

## What it says

**The floor is the whole story.** The hookScripts agent read one file, correctly concluded no
change was needed, and stopped — and still spent **117,663** tokens. That is the price of
existing: CLAUDE.md, rules, and tool schemas injected at boot. Every other number in the table is
that floor plus a few thousand tokens of actual work.

| | tokens/file | vs merged |
|---|---|---|
| merged find+fix | 120,454 avg | 1.00× |
| split reader→fixer | 246,855 | **2.05×** |
| merged, `tldr`-only | 122,529 | 1.02× |

1. **Splitting reader and fixer costs 2.05× for identical output.** Not because the file is read
   twice — because the *floor* is paid twice. The fixer also cannot use the reader's context, so
   it re-reads the file anyway.
2. **Reading less did not help.** Arm C used `tldr structure`/`definition`/`search` and read 170
   lines total instead of a whole file — and came out **2% worse**, because its 15 tool calls
   each re-read a growing transcript. Byte discipline pays off around a thousand lines; below
   that it is noise against the floor.
3. **So the lever is fewer LAUNCHES, not fewer bytes.** Batch several files into one worker. This
   contradicts the one-file-one-owner rule as first written: that rule exists to prevent two
   workers writing one file, and one owner can own five files without any collision.

## Two findings that were not about tokens

**A `tsc --noEmit` is a GLOBAL verifier.** All three Arm-A workers ran it concurrently and each
reported errors belonging to another worker's half-finished edits; each had to reason about which
diagnostics were its own. Whatever verifies a tree cannot be trusted while others edit that tree —
which is why the fix lane in the template is serial.

**Type-checking is not verification.** Every worker reported `tsc=clean`, and the migration was
still broken: `spawnServerWithRetry` froze its `getLog()` at readiness, so a suite asserting on
lines the server prints *after* boot read a boot-only snapshot. Nothing found it until the suites
were actually RUN. A pipeline whose verify step does not execute the code ships green failures.
