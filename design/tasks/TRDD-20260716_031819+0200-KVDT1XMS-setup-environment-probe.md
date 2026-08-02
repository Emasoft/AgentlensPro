---
trdd-id: KVDT1XMS
title: Setup environment probe — heuristic incompatibility checks, WSL-only Windows gate, help+skill sync
column: human_review
created: 2026-07-16T03:18:19+0200
updated: 2026-08-02T11:35:13+0200
current-owner: main
task-type: feature
severity: major
scope: project
npt: []
eht: []
---

# Setup environment probe — heuristic incompatibility checks + cross-platform gate

USER (2026-07-16, verbatim): "verify the installation procedures and automate it to be as simple
as possible, checking with heuristic probes if there are problems or incompatibilities. make sure
it is cross platform (but windows WLS only)."

## Design

`agentlenspro setup` already runs the CHECK→ACT→VERIFY step pipeline (7 steps, fail-fast). Add a
NEW read-only **stepEnvironment** as STEP 0 — pure heuristics, never ACTs:

| probe | FAIL (blocks setup) | detail-only (warns) |
|---|---|---|
| platform | `win32` native — "unsupported; run inside WSL2" (inside WSL `process.platform === 'linux'`, so the gate never blocks WSL) | WSL noted as `linux (WSL)` — reuses `src/environment/runtime.ts` marker detection (one source of truth) |
| Node floor | `< engines.node` (>=20.9.0, read from package.json — never hardcoded twice) | — |
| native deps | `@duckdb/node-api` unresolvable (declared runtime dep — the span store needs it; a broken install must not half-run) | `sql.js` unresolvable (degradable: OpenCode falls back to per-message JSON) |
| port conflicts | — | a listening OTLP/UI port owned by a FOREIGN process (not our server: `/api/server-stats` shape probe) |
| Claude presence | — | `~/.claude` absent (hooks/skill steps will install into a dir Claude Code has never read) |
| disk space | — | < 1 GB free on the dataDir volume |

FAIL semantics follow the existing pipeline: fail-fast, remaining steps SKIP, exit non-zero.
Probes are injectable (ctx paths/ports) so tests drive them against fixtures.

## Also in scope (docs ride with the code)

- `USAGE` in src/cli/diagnosticsCli.ts: document the probe + platform support line
  (macOS / Linux / Windows via WSL2 only).
- `skills/agentlenspro-diagnostics/SKILL.md`: setup section — probe description, platform
  matrix, the new get_recent_sessions `active` flag and card `title`/`entrypoint` fields.
- CHANGELOG entries for all three TRDDs of this work order (OMMPS5TF, RS3NGN53, KVDT1XMS).

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113227+0200-batchB-server-ingestion.md
