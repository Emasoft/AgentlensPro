---
trdd-id: M8SV6LK5
title: CLI sources production-readiness review — re-scoped against today's src/cli
column: dev
created: 2026-08-02T01:26:42+0200
updated: 2026-08-05T03:35:38+0200
current-owner: session
task-type: audit
supersedes: K7PQ2M4V
relevant-rules: []
npt: []
eht: []
---

# CLI sources production-readiness review — re-scoped

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**IN PROGRESS.**

> **`updated:` went BACKWARDS once, on purpose.** Three edits during this session typed it from
> memory instead of reading `date`, landing up to two hours in the future (a `04:55` while the clock
> said `02:58`). The board sorts on this field, so a fabricated future stamp parks a card at the top
> of every view until the clock catches up. It is now stamped from `date` on every edit. If the git
> log shows this field decreasing around 2026-08-05T03:00+0200, that is the correction, not a bug —
> do not "fix" it forward. **Read the clock; never type a timestamp.**

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

8. **The pattern list PAID OFF — shape 3 swept across all remaining files in one grep (`a48c0ce`).**
   This is the method working as intended: no file was read end-to-end, the grep named the
   candidates, and each was verified against the source before any edit.

   - **`envCli.ts` had NO validator at all** and failed in both directions, silently: `env --out` as
     the last token dropped the request and printed to stdout with **exit 0** (shape 2 — a request
     not fulfilled, reported as success), `env --out --json` wrote a file named `--json` and never
     applied `--json`, and `--out=` empty was the same drop. All measured on the installed command.
   - **`budgetCli.ts` and `watchCli.ts` are CLEAN** — they route through `argHelpers.strArg`/`numArg`.
     `strArg` already rejects a flag-shaped value; `numArg` gets it for free (`Number('--x')` is NaN).
   - **`ctxvisCli.ts:445`'s unpaired `writeFileSync` is NOT shape 4** — it is a best-effort
     `--reuse-last` cache inside a try/catch with a comment saying so. Checked, not assumed.

   **The real finding is the duplication, not the third instance.** `strArg` has implemented this
   check all along, and `argHelpers`' own header warns that *a second copy of a validator is how one
   of them quietly stops rejecting*. Three surfaces never routed through it — and `takeValue`, which
   I added to `diagnosticsCli` in item 7, was itself that second copy. It is gone; both files now
   call `strArg`, which gained an optional `what` so a caller can say "a path" (default unchanged, so
   `watchCli`'s existing message assertion still holds). 9 tests, falsified, PATH-verified. Suite
   2,084.

   That suite also chdirs to a throwaway directory, for the reason item 7 records: **these cases
   WRITE the junk file when the guard is absent**, which is the state a falsification pass creates.

9. **`statuslineHistoryCli.ts` REVIEWED — and shape 3 has an OPPOSITE, worse form (`75c2325`).**
   The file is otherwise the best-hardened in `src/cli` (its honesty contract is written at the top
   and held everywhere I checked). The defect is in how it looked flags up.

   Both this file and `ctxmapCli` carried a private lookup that mapped a flag-shaped value to
   `undefined` — deliberately, so `--out --json` could not create a file named `--json`. Avoiding the
   junk file was RIGHT; discarding the flag to do it was not, and the command then ran as if the flag
   had never been typed. MEASURED on the installed CLI:
   - `statusline-history sessions --session --json` → **14 sessions instead of 1**, exit 0, and the
     `--json` reported no session filter at all.
   - `ctxmap --list --limit --json` → silently used the default 20.
   - both `--out --json` → exit 0, no file.

   **A missing file is a nuisance; an unfiltered answer presented as a filtered one is a WRONG
   ANSWER, and nothing in the output says so.** So shape 3 has two faces and the sweep must look for
   both: *accepting* a flag as a value (a48c0ce) and *discarding* the flag entirely (here). Now one
   lookup, `argHelpers.flagValue` — absent → undefined (that is what optional means), present with a
   bad value → UsageError, `bareOk` for the one legally valueless flag (`--project`).

   Two latent issues fell out of doing it properly, neither reachable before:
   - `statusline-history` read its flag values INSIDE the `try` meant for the time parser, so one
     flag would have reported a caller mistake as a return code while its siblings threw.
   - **`ctxmap`'s catch had no `UsageError` branch → a caller mistake would have returned 1**, which
     `cliErrors` reserves as the watchers' ABORT signal and a watcher wires straight to its kill path.

   11 tests, falsified (7 fail against the silent-drop version; the correct-usage cases pass in
   both), PATH-verified including that bare `--project` still works and a real `--session` still
   filters to 1 row. Suite 2,095.

10. **`watchCli.ts` REVIEWED — 2 defects, fixed and deployed (`fb25bac`).** Both are shape 2, and
    both were found by reading the file against ITS OWN stated contract rather than against the
    generic list — which is the lesson worth carrying: this file writes its invariants at the top,
    so the fastest audit is to check whether it keeps them.

    - **`tokens-per-min` reported a blind feed as a quiet machine.** It summed
      `w.fiveMinTokensPerMin || 0`, which guards the empty ARRAY but not windows carrying no rate —
      those summed to a measured **0**, and a `NaN` did too. MEASURED against the compiled module:
      `read({accountWindows: [{}, {}]})` → `0`. The file's own `n()` helper exists to prevent exactly
      this ("null, not 0"), and this is the worst place to break it: for a burn watcher `0/min` reads
      as "nothing is burning", so a threshold watch sat SILENT while blind — and the loop's `blind`
      transition line, written to announce that state, only fires on `null` and so never could.
    - **`--for N` was not a deadline.** Checked only at the top of the loop while the sleep was
      always a full interval, so it overshot by up to one interval, took one more sample WITH its
      alerts after the window closed, and then reported the REQUESTED duration. `--for 1
      --interval 900` ran ~15 min and printed "watch window elapsed (1m)". A deadline that is not a
      deadline is worse than none, because a harness sizes its own timeout around it.

    10 tests, falsified (4/4 targeted fail against the reverted logic, and every over-refusal guard
    — genuine zero, partial feed, plain interval — passes in BOTH). PATH-verified end to end: the
    same `--for 1 --interval 900` now stops at **68 s** and prints "1m requested, 1m actual".
    Suite 2,105.

    Timing lived inside the poll loop with no seam, exactly like `runGuard` in item 7; it is now the
    pure `nextSleepMs`. **Two of eleven defects have now hidden in an untestable loop — treat a
    `for(;;)` with logic inline as a finding in itself.**

11. **`budgetCli.ts` REVIEWED — 5 defects (`72594a5`, `f8d5eac`). The first is the file's own worst
    case, one layer below where it was already guarded.**

    - **The projection and the account cross-check could read DIFFERENT windows.** `bindingWindow` has
      THREE documented values (`src/windowEta.ts` types it `'5h' | '7d' | 'none'`). `'none'` is
      truthy, so it sailed past the `|| '5h'` fallback and became the window KEY — and two consumers
      resolved that same key by different rules: `pickWindow`'s `key === '7d' ? sevenDay : fiveHour`
      gave the **5h** window to the projection, while `officialBuckets`' `key === '5h' ? session :
      startsWith('weekly')` gave the **7d** buckets to the cross-check. MEASURED live: bindingWindow
      `none`, 5h **81%**, 7d 31% — `applyOfficial` downgrades at ≥80 but was handed 31, so **budget
      answered GO with the 5h window at 81%**. "none" was printed to the operator as a window name.
    - **`--with-risks` failed SILENTLY.** Zero `[burn-guard]` lines against a dead risk endpoint and
      no hint the feed had failed — a caller who asked for risk coverage and gets nothing reads it as
      "no risks", the one conclusion silence cannot support. Now reported once per outage.
    - **The watch overran its own deadline** by up to one poll interval before reporting completion,
      and reported the REQUESTED duration: 33 s for a 15 s window, printed "(0m)". Now 15 s.
    - **The arm-time official line hardcoded `'7d'`** for `--window binding`, announcing a binding
      window that later verdict lines could contradict. The note is omitted until it is resolved.
    - **A rejected reading named a cause that had not fired** — found by running the FIXED command on
      PATH, i.e. by the verification rather than the review. `deriveStale` has two causes and the
      second (a window that has already RESET) is the one that matters; `budget` rendered every stale
      reading as an age in whole hours, so it printed **`NOT USABLE — the cached reading is 0h old
      (fresh)`**. `subscriptionUsage` now exports `staleReason()` and `deriveStale` delegates to it,
      so the boolean and the explanation share one set of predicates.

    13 tests. `nextSleepMs` moved to `cliCore` beside `sleep`: both long-lived watchers had the same
    deadline bug, and two copies of that arithmetic is how one stops trimming. Suite 2,117.

    **The lesson that generalises: TWO of these were found by the verification step, not the read.**
    Running the fixed command on PATH is not a formality — it is a second, independent detector.

12. **`statuslineCapture.ts` REVIEWED — 2 defects (`a9b983a`), and shape 6 swept with a NEGATIVE
    result.** The file states three contracts in its header; it breaks the second in the degraded
    case, which is the case that contract exists for.

    - **A wedged server froze the render.** Contract 2 says "a hung socket must not hold the status
      line hostage — a dropped sample is invisible, a frozen status line is not", and the wrapper
      then awaited the capture outright after the child. MEASURED on PATH: **102 ms healthy, 787 ms**
      against an endpoint that DROPS — past Claude Code's 300 ms debounce, every render. **A closed
      port refuses instantly, so a suite that only tested "server down" could never see this** — the
      same blind spot that hid the 75 s hot-path stall. Now a residual budget after the child:
      **157 ms** wedged, healthy unchanged. Not hypothetical: `TRDD-2YP3DB9Y`'s OOM put the server in
      exactly that state tonight.
    - **`--inner --subagent` ran the flag as the command.** `sh -c "--subagent"` exits non-zero and
      contract 1 is that a non-zero exit BLANKS the user's status line. The falsification pass proved
      it by leaking `zsh: no such option: subagent` into the test output. Treated as absent now —
      deliberately NOT an error, since an error exits non-zero too and would cause what it diagnosed.

    6 tests, falsified (3/3, the timing one failing at exactly 705 ms). `runStatuslineCommand` takes
    its input stream as a parameter: `process.stdin` yields one EOF per process, so a suite asserting
    two invocations hangs on the second. Suite 2,122.

    **Shape 6 swept across `src/cli` + its consumed modules — NO second instance.** `etaReason`
    (5 members) is produced and consumed only inside `windowEta.ts`, with all five branched and
    tested; `accountVerified` is fully branched; `AuthRegime`/`TtlSource` have no CLI consumer.
    Recording the negative result because a sweep that lists only hits cannot be trusted later.

13. **`ctxvisCli.ts` REVIEWED — 4 defects (`aa31812`), one of them A MISS FROM THIS AUDIT'S OWN
    SWEEP.** The file promises, in its usage text: *"Every number that says 'measured' came from
    count_tokens; nothing is estimated."* Four ways it did not keep that.

    - **A PARTIALLY measured turn was presented as fully measured.** `exactifyReport` leaves an
      uncountable element at its ESTIMATED value and still sums it into the turn total, but ctxvis
      warned only when EVERY element failed. `ctxmap` surfaces exactly this
      (`reportMeasurementCaveats`) — the consumer WITHOUT it is the one whose numbers are written
      into the persisted baseline store and become ground truth for later runs.
    - **The flag lookup dropped a flag with no value** — the same helper already fixed in `ctxmapCli`
      and `statuslineHistoryCli`. **This file was in that sweep's grep output (`ctxvisCli:259`) and I
      acted on only two of three.** `--subject --json` left NO agent as the subject, so the
      environment fingerprint validating every cached baseline came from an arbitrary one;
      `--baselines --json` wrote the store to its DEFAULT path while the caller believed otherwise.
    - **EVERY throw returned 64.** An unreadable baseline store or a corrupt capture told a harness
      its command line was wrong. Caller mistakes are `UsageError` now; everything else is runtime.
    - **`--html` was validated only AFTER the credential check and the whole measurement**, so a bad
      value was refused once the run had already spent its `count_tokens` calls.

    6 tests, PATH-verified. Suite 2,128.

    **THE LESSON, and it is about the method, not the file: the first version of these tests passed
    against the BROKEN code.** They used a bogus nonce, `assertNonce` rejected it during argument
    parsing, and the pre-fix blanket `return EXIT.USAGE` made every one of them green — so they
    proved nothing about the flag they named. Green tests, a correct fix, and a suite lying about
    both. **Only the falsification pass could have caught it.** A test whose SETUP trips an earlier
    guard never reaches the code under test, and that is invisible while it is green (`10b81ab`).

**NEXT ACTION:** take the next per-file surface by hand. Shapes 3 and 4 are SWEPT across all of
`src/cli` — but shape 3 now has TWO faces (accept-as-value and discard-the-flag), and the sweep that
found the first would have missed the second, so **re-read the shape list below before trusting the
sweep**. Shapes 1, 2 and 5 still need a read; none is greppable. Shape 6 is SWEPT (no second instance). Unreviewed and largest first:
`setup.ts` (994, but it already has two dedicated test suites) and `hookInstall.ts` (594, partially
covered by the TOCTOU work). Whatever produces the findings, they are a HYPOTHESIS list: verify each
against the source before any edit.

**A SWEEP IS NOT DONE WHEN THE GREP RETURNS — it is done when every hit is dispositioned.** Shape 3's
sweep listed `ctxvisCli:259` and I fixed two of the three files it named. Write the hit list down and
tick it off; "I remember which ones mattered" is how the third one survives.

**AND FALSIFY EVERY TEST, not just the risky-looking ones.** The first `ctxvisCli` tests passed
against the broken code because their fixture tripped an earlier guard. A green test that never
reaches the code under test is indistinguishable from a real one until you break the code on purpose.

**Shape 6 — a value with more states than its consumers handle.** `bindingWindow` is
`'5h' | '7d' | 'none'` and every consumer assumed two; the third was truthy, so it slipped past a
`||` fallback and each consumer resolved it differently. Grep the TYPES for a union whose third
member has no branch, and check the `||`/`??` fallbacks that are supposed to catch it.

**Two methods have now outperformed the generic shape list, and both are cheaper:**
- **Read a file against ITS OWN stated invariants.** `watchCli` and `statuslineHistoryCli` both write
  their contracts at the top; in both, the defect was the one place the file broke its own rule.
- **Shape 5 — logic inside a `for(;;)` with no test seam.** Two of eleven defects hid there
  (`runGuard`'s advice flag, `watch`'s deadline). Extracting the step to a pure function is what
  made each testable, and each extraction found the bug immediately.

**The pattern to look for, now that it has SIX instances across two files** — it is the productive
hypothesis, not a summary: *the command reports success while having misread the request or thrown
the answer away.* Concretely, four shapes worth grepping for in the files still unreviewed:

1. a two-stage scan whose stages disagree about what counts as a match;
2. a "no results" path whose exit code or message asserts more than the run established;
3. a flag's value handled without checking it IS one — in EITHER direction, and the second face was
   found only after the first was already "swept": **(a)** `argv[++i]` accepted as a value when it is
   the next flag, and **(b)** a flag-shaped value mapped to `undefined`, which discards the flag and
   answers a different question;
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
