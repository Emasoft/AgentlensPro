---
trdd-id: M8SV6LK5
title: CLI sources production-readiness review — re-scoped against today's src/cli
column: dev
created: 2026-08-02T01:26:42+0200
updated: 2026-08-05T02:05:00+0200
current-owner: session
task-type: audit
supersedes: K7PQ2M4V
relevant-rules: []
npt: []
eht: []
---

# CLI sources production-readiness review — re-scoped

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**IN PROGRESS.** Three things are done; one is running.

1. **Starting condition confirmed** — `reports/cli-revision/` was empty, exactly as this card
   predicted. Bundle current (2.23.0, rebuilt + deployed this session).
2. **FRESH baseline captured** — `reports/cli-revision/20260805_002915+0200-baseline.md`: all six
   gates green, and the file inventory re-measured (27 files, 8,232 lines). **Cite that file, never
   K7PQ2M4V's numbers** — citing stale numbers is exactly how the previous card died.
3. **First known-open item FIXED** (`8c47b4e`): `server start` announced a failure that had not
   happened. The defect was a DECISION, not a duration — startup is O(store), so a fixed 20 s budget
   failed precisely on the machines that use the tool most. The wait is now bounded by LIVENESS
   (`startupVerdict`, a named pure function with its four cases pinned), a dead child fails in
   ~250 ms with the log tail attached instead of after 20 s with a pointer to a file, and the
   timeout message states what is TRUE rather than announcing a failure. 8 new tests; suite 2,055.
4. **Delegated per-file review FAILED — and the free pool is why.** `llm-ext scan-folder` over
   `src/cli/*.ts` ran 17 minutes and produced **zero** reports. The log says it plainly:
   `[circuit-breaker] 77 consecutive failures detected` and ~76 `[model-retry] …:free: request error:
   This operation was aborted` across `nvidia/nemotron-3.5-content-safety:free`,
   `poolside/laguna-xs-2.1:free` and `cohere/north-mini-code:free`. The progress counter sat at
   "50/100" the whole time while worker batches restarted from 60s — it was looping on retries, not
   advancing. Killed.

   **Do NOT simply re-run it.** The models themselves are aborting; a narrower batch may complete but
   the same pool is the bottleneck. Options, in order: (a) re-run over the FIVE largest files only;
   (b) ask the owner whether a PAID OpenRouter profile is acceptable — that costs money, which is
   their call, and this card's "costs nothing against the Anthropic window" constraint is about the
   Anthropic window, not about spending nothing at all; (c) review by hand, which is what happened
   for the files reviewed so far.

5. **Cross-file findings so far (the half the externalizer structurally cannot produce):**
   - Every network call site in `src/cli` is bounded — verified by reading all four raw sites
     (`hookHandlers` ×2 via `AbortSignal.timeout` with the `Number(env)||default` guard, `setup.ts`
     ×2 via `req.setTimeout`). Pinned by `src/test/cliNetworkBounds.test.ts` (`5bfa886`).
   - **That guard was itself too narrow**, found by asking where the CLI's outbound calls actually
     live: `count_tokens` (`src/exactTokens.ts`) and the profile endpoint
     (`src/subscriptionUsage.ts`) sit one level ABOVE `src/cli`, so a `src/cli`-only scan would
     declare the CLI safe while the calls it makes went unchecked. Both are correctly bounded today;
     the scan now covers `src/cli` + the top level of `src/`, and deliberately not the subdirectories
     (the server holds long-lived connections by design; a noisy guard gets deleted). `df8a12e`.

6. **`ctxmapCli.ts` REVIEWED by hand — 3 defects, all fixed and deployed (`9eb5c26`).** Route (c) —
   by hand — is what produced them; the free pool never would have, since two of the three are
   cross-stage and one is a cross-file consistency break.

   All three are the SAME failure wearing different clothes, which is the finding worth carrying
   forward: **the scan reported a confident ANSWER for a lookup that never completed.** In a tool
   whose entire job is "is X in my context", a false negative is indistinguishable from a true one
   and the reader stops looking.

   - **`--find` decided on ONE spelling while its own prefilter tried TWO.** Captures are JSON on
     disk, so a needle carrying a quote or backslash matches only its escaped form. The prefilter
     knew that (and its comment says testing one form "silently MISSES real hits"); the deciding
     stage then re-serialised the parsed body and tested only the literal needle. MEASURED through
     the installed command against a capture containing `he said "hi" loudly`: `--find 'said "hi"
     loudly'` printed `(no match)`.
   - **`--list` was the one scan in the file still calling `fs.readdirSync` directly.** A dir that
     exists but denies listing passes the read scope's `isDirectory()` check and throws EACCES out of
     the command — and the spool is scanned FIRST, so one unreadable dir suppressed every capture in
     the readable ones. MEASURED: exit 1, `EACCES: permission denied, scandir …/spool`.
   - **`--list` on an empty spool returned EX_USAGE 64**, which `cliErrors.ts` documents as never
     coming from a healthy invocation. Now `EXIT.UNKNOWN` plus the actionable half the old message
     lacked (says when capture is OFF).

   5 tests in `src/test/ctxmapScanHonesty.test.ts`, **verified to fail against the pre-fix source**
   (4 failing, with the real EACCES and the literal `(no match)` in the output) and re-verified
   through `agentlenspro` on PATH after `deploy:safe`. One is a negative control — a genuinely absent
   needle must still report no match — so the escaping fix cannot degrade into matching everything.
   Suite 2,065.

7. **`diagnosticsCli.ts` REVIEWED by hand — 3 more defects, fixed and deployed (`47d5951`,
   `fd0033d`).** Found by hunting the shape item 6 named, which is the argument for writing it down.

   - **The ops flags took the next token as their value without checking it WAS one.** `--out --json`
     exited 0, wrote a file literally named `--json`, and dropped the `--json` the caller asked for.
     The severe form is `--export-bodies --json`: MEASURED at **345 MB / 542 raw request bodies**
     written into a directory named `--json` in the cwd — untracked, un-gitignored, one careless
     `git add -A` from publication. **Exiting the CLI does not stop it** — the export runs
     server-side and the server had to be stopped. (That measurement was involuntary: the
     falsification pass ran the test against the unguarded code and triggered a real export. The
     files were staged to `.trashcan/`, not deleted.)
   - **`--out` discarded the answer when its directory did not exist** — ENOENT from the LAST
     statement, after the server had done the work. `ctxmap`'s emit always created the dir.
   - **The burn guard advised on its first episode and never again for the life of the process.**
     Risk codes and two control sentinels shared one Set, so `size > 0` — the test for "is an episode
     running" — never went false again once the advice flag was added. The transitions are now a pure
     exported `guardStep`, because the reason this was never caught is that it lived inside an
     infinite polling loop with no seam to test.

   10 tests, **verified to fail against the pre-fix source** (5 of 5 targeted), re-verified through
   `agentlenspro` on PATH after `deploy:safe`. Suite 2,075.

   **A test for a guard runs in the state where that guard is missing** — that is what a falsification
   pass IS, and what a regression creates. This suite was not safe in that state; it now points the
   endpoint at a port that refuses instantly, so a regression fails an assertion instead of exporting
   the archive into the working tree. Re-verified by re-removing the guard: fails, creates nothing.

**NEXT ACTION:** take the next per-file surface by hand — route (c) is working, so (b) is no longer
blocking (it stays an option if the remaining surface proves slow). Unreviewed and largest first:
`setup.ts` (994, but it already has two dedicated test suites), `statuslineHistoryCli.ts` (686 — note
its STORE was hardened separately, see Out of scope; the CLI view was not), `watchCli.ts` (529),
`hookInstall.ts` (594, partially covered by the TOCTOU work). Whatever produces the findings, they
are a HYPOTHESIS list: verify each against the source before any edit.

**The pattern to look for, now that it has SIX instances across two files** — it is the productive
hypothesis, not a summary: *the command reports success while having misread the request or thrown
the answer away.* Concretely, four shapes worth grepping for in the files still unreviewed:

1. a two-stage scan whose stages disagree about what counts as a match;
2. a "no results" path whose exit code or message asserts more than the run established;
3. `argv[++i]` taken as a value with no check that it is not itself a flag;
4. a write of an expensive result with no `mkdir -p` before it.

None of the six crash. That is why none were caught by a suite that was green throughout, and it is
the reason this card is a READ of the source rather than a test-writing exercise.

**The exit-code contract is VERIFIED cross-file — do not re-derive it.** It holds through two
mechanisms that reconcile in one place, which is why a single grep looks inconsistent:

- The file-backed verbs **RETURN** a code (`allAccountsCli` → `EXIT.BLIND`, `cacheExpiredCli` →
  `EXIT.UNKNOWN`, `lastCompactCli` → `EXIT.USAGE`, …).
- `diagnosticsCli.emit()` cannot return — it prints inside a dispatch that returns 0 — so a refusal
  sets `process.exitCode = EXIT.UNKNOWN` and writes the reason to **stderr**, leaving stdout empty.
- `standalone/cli.ts` reconciles both with `code || process.exitCode || 0`, so a command that
  completed while refusing keeps the refusal instead of republishing success over it.

Two defects WERE found on that path and are fixed: the top-level catch left via a bare
`process.exit()` (`c851bcd`), and the connect deadline was bounding the RESPONSE (`d388709` — see the
handoff; it was caught only by running the installed command on PATH, with the whole suite green).

**Second known-open item still open:** the hot-path exit semantics are now additionally pinned by
`src/test/cliHotPathLatency.test.ts` (TRDD-E8XIC2PM, shipped tonight) — the classification beside the
dispatch means a refactor that drops `exitNow` from a hot-path command now fails a test rather than
shipping.

**This supersedes TRDD-K7PQ2M4V**, which was not resumable as written.

**Why K7PQ2M4V was superseded rather than continued** — three facts, each verified on disk before
this card was written, not inferred:

| check | finding |
|---|---|
| its `column:` / `updated:` | `dev` / **2026-07-23** — 9 days untouched while claiming to be in progress |
| its NEXT ACTION (`ls -t reports/cli-revision/`) | **0 files** — the delegated review it depends on does not exist |
| commits touching `src/cli/` since it stalled | **19** |
| its five priority files | ALL grew: setup 944→991, diagnosticsCli 571→669, serverControl 448→509, hookInstall 305→**545**, configCli 205→212 |

So its regression baseline describes a codebase that no longer exists, and its input artifacts are
gone. Continuing it would mean auditing against numbers that are no longer true.

**NEXT ACTION** — regenerate the review input first, because there is none:

```bash
agentlenspro --version && node esbuild.js          # confirm the bundle is current FIRST
ls -t reports/cli-revision/ 2>/dev/null | head     # expect empty; that is the starting condition
```

Then re-run the delegated per-file review over `src/cli/*.ts` and capture a FRESH baseline
(`pnpm run check-types`, `pnpm run lint`, `npx mocha`) before any edit.

**Carried forward from K7PQ2M4V — still true, do not re-derive:**

- **Delegate the per-file read, keep the whole-repo view yourself.** The externalizer batches 1–5
  files per request, so cross-file duplication across 20 files is structurally invisible to it. The
  first real bug that card found came from exactly that blind spot.
- **Findings are a HYPOTHESIS list, never a work order.** Every finding is verified against the
  source before any edit; the project's claim-verification rule applies unchanged.
- Run the review on OpenRouter, so it costs nothing against the Anthropic 5h/7d window.

**SUPERSEDED — do NOT carry forward:**

- K7PQ2M4V's regression baseline table (measured 2026-07-23 against files that have since grown).
- Its file-size figures and its "five priority files" line counts.
- Its NEXT ACTION as written (`ls -t reports/cli-revision/`) — that directory is empty.

## Scope

`src/cli/*.ts`. Re-measure the file inventory at start rather than trusting any number written here;
that is the specific way the previous card went stale.

## Known-open items already identified, to fold in rather than rediscover

- **`server restart` reports "not ready within 20s" while the server HAS started.** Observed
  2026-08-01: the process came up and served correctly, and the single-owner guard then correctly
  refused a second start; only the readiness probe timed out, on a store holding 2.89M spans. The
  probe's budget does not scale with store size. Evidence:
  `reports/statusline-cache-verification/20260801_232422+0200-cache-view-validation.md` (context) and
  the server log at that timestamp.
- **Hot-path exit semantics are now load-bearing and easy to break.** `statusline`/`hook`/`gate`
  exit via `exitNow` (flush stdout, then hard exit). Both halves are required and each undoes the
  other if removed — see `src/cli/main.ts` and the paired tests in `src/test/hookScripts.test.ts`.
  Any refactor of the dispatch path must keep both.

## Out of scope

The status-line capture/store subsystem (`statuslineCapture.ts`, `statuslineStore.ts`,
`statuslineUsage.ts`, `statuslineHistoryCli.ts`) was reviewed and hardened in depth on 2026-08-01/02
— seven defects found and fixed, each with a regression test verified to fail against the broken
version. Re-auditing it here would duplicate that work. Its lessons live in
`.claude/project/memory/statusline-capture-and-store.md`.
