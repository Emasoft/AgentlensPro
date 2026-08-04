---
trdd-id: M8SV6LK5
title: CLI sources production-readiness review — re-scoped against today's src/cli
column: dev
created: 2026-08-02T01:26:42+0200
updated: 2026-08-05T00:32:00+0200
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
4. **Delegated per-file review RUNNING** on OpenRouter free-pool (zero Anthropic window cost, as this
   card requires): `llm-ext scan-folder` over `src/cli/*.ts`, `answer_mode 0` (one report per file),
   instructions at the scratchpad path in the launch command. Reports land in
   `reports/llm-externalizer/`. It was at 50% after 3 min — free models are slow; check for the
   `.md` outputs before assuming it failed.

**NEXT ACTION:** read the per-file reports as a HYPOTHESIS list — every finding verified against the
source before any edit — and keep the cross-file view yourself (the externalizer batches 1–5 files
per request, so cross-file duplication is structurally invisible to it).

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
