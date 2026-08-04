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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-02

**State:** NOT STARTED. This supersedes TRDD-K7PQ2M4V, which was not resumable as written.

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
