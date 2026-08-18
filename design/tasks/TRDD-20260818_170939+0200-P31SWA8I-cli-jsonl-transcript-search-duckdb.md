---
trdd-id: P31SWA8I
title: CLI transcript search — query a session's jsonl (tool outputs, agent responses) via DuckDB read_ndjson
column: complete
created: 2026-08-18T17:09:39+0200
updated: 2026-08-18T17:35:00+0200
current-owner: AgentlensPro session
task-type: feature
severity: MEDIUM
priority: 2
labels: [cli, transcripts, duckdb, debugging]
relevant-files: [standalone/cli.ts, src/cli, src/logReader.ts, src/store/db.ts]
release-via: publish
---

# `agentlenspro search` — jsonl transcript search over DuckDB

USER directive (2026-08-18, relayed from another session's transcript; a prior verbal order that
never got its card — this card repairs that): *"searching the jsonl for the tool outputs or agents
response could help debugging... the agentlenspro cli should have some function to search the
jsonl of a specified agent session"* — implemented with *"the superfast jsonl query ability of
duckdb"*. Verified gap: the CLI surface today is observability only (spans, usage, cache-expired,
last-compact, budget, watch, hooks); nothing reads session `.jsonl` CONTENT.

## Design sketch (decide details at pickup)

- `agentlenspro search <pattern> [--session <id>] [--agent <id>] [--project DIR] [--role
  user|assistant|tool] [--type tool_result|text|thinking] [--since/--window] [--limit N] [--json]`
- Engine: DuckDB `read_ndjson_auto` over the resolved transcript path(s) (`LogReader.
  transcriptPathFor` + subagent transcript resolution already exist) — SQL does the filtering/
  projection (`WHERE message.content ILIKE ...` / regexp_matches), multi-threaded by the
  machine-scaled threads default (TRDD-7I5805QM). No JS-side full-file materialization.
- Output: matching entries as (line#, ts, role/type, excerpt with the match highlighted); `--json`
  for machines. Self-scopes to the cwd project by default, like cache-expired.
- Fail-fast flag contract (strict parser, unknown flag exit 64 — TRDD-PIB6T4RU).
- NOTE (TRDD-DMWOBWFH): when the Rust core lands its log-reader phase, this becomes a Rust query
  path; the CLI surface/flags defined here are the stable contract either way.

## Acceptance

- [x] search by pattern within one session id (main AND subagent transcripts resolvable —
      `LogReader.transcriptPathFor` exact id, plus unique >=6-char prefix over `collectFileMeta`)
- [x] filter by role/type; bounded output with honest truncation note (`--limit` bounds hits,
      `total` on stderr/`--json` always reports the full match count)
- [x] a 60MB transcript searches in seconds — MEASURED far past the bar: **147.6MB transcript,
      20,792 matches, 365ms** (and 4.2MB in 43ms). DuckDB `read_ndjson_objects` streaming; line
      numbering, filters, excerpt windows and the total all computed in SQL, nothing enters V8.
- [x] tests: fixture transcript + 6 query shapes (`src/test/searchCli.test.ts` — literal
      case-insensitive, role/type filters, regex, limit-vs-total, quote escaping, MB-scale line)
      + 3 usage-contract tests; unknown flag exits 64 (verified through the bare command:
      exit 64 bad flag, exit 2 not-found with stdout empty, exit 0 with matches)

## Approval log

- 2026-08-18T17:09:39+0200 — Card authored at `todo` under the USER's standing directive "write a
  TRDD every time I say something about a change". The original verbal order predates today and
  was missed — recorded now so it cannot be lost again.
- 2026-08-18T17:35:00+0200 — COMPLETE. `src/cli/searchCli.ts` (engine + verb), registered in
  `src/cli/main.ts` (MANAGEMENT_VERBS/dispatch/LATENCY_EXEMPT) and the global USAGE. Full suite
  2399 passing; verified through the bare `agentlenspro` on PATH (npm link → this repo's bundle,
  symbol grep confirmed). Rides the v2.29.0 publish together with [[TRDD-7I5805QM]].

## Notes and lessons learned
