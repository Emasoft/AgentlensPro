---
trdd-id: P31SWA8I
title: CLI transcript search — query a session's jsonl (tool outputs, agent responses) via DuckDB read_ndjson
column: todo
created: 2026-08-18T17:09:39+0200
updated: 2026-08-18T17:09:39+0200
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

- [ ] search by pattern within one session id (main AND subagent transcripts resolvable)
- [ ] filter by role/type; bounded output with honest truncation note
- [ ] a 60MB transcript searches in seconds (DuckDB, not a JS line loop) — measured in the card
- [ ] tests: fixture transcript + at least 4 query shapes; unknown-flag exit 64

## Approval log

- 2026-08-18T17:09:39+0200 — Card authored at `todo` under the USER's standing directive "write a
  TRDD every time I say something about a change". The original verbal order predates today and
  was missed — recorded now so it cannot be lost again.

## Notes and lessons learned
