---
trdd-id: UIQS9RXZ
title: search across all sessions of the project - increment 1 scope filters and output
column: todo
status: tasked
created: 2026-11-16T23:48:04+0100
updated: 2026-11-16T23:49:28+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:48:04+0100
---

# search across all sessions of the project - increment 1 scope filters and output

Owner request 2026-11-16 (verbatim): "one new feature to implement: many claude agents spend a lot of tokens searching manually into the previous sessions transcripts, and that is a waste of money and context memory. Add a new command to agentlenspro cli: search. this command should use the powerful and lightining fast ability of duckdb to parse jsonl files to search for strings and keywords (fuzzy or with masks too) across all the current and past sessions of the current project folder. a sort of grep for the jsonl transcripts elements and entries, but using duckdb as parser. Add the secondary options necessary to include searches for special types and categories of entries, tool outputs, diffs, subagents sessions and reports, hook injections, model changes, tools and commands of any kind. thanks to duckdb it would be easy to add filters for time windows, specific sessions id, subagents id, tool names, file names, commits, branches, worktrees, etc."

## What exists
`agentlenspro search <pattern> --session ID` (TRDD-P31SWA8I, src/cli/searchCli.ts, 184 lines; tests src/test/searchCli.test.ts). One transcript only, `--session` REQUIRED, flags --role --type --regex --limit --json. It matches the raw JSON line.

## Measured on this project (read only; scripts_dev/search-probe.cjs and search-probe2.cjs, outputs reports_dev/search-v2/probe.txt and probe2.txt)
- 92 main transcripts + 3155 subagent transcripts (`<sid>/subagents/agent-<id>.jsonl`), 3.15 GB, 582373 entries. 4 sibling project folders exist (2 are `<slug>--claude-worktrees-*`).
- Raw case-insensitive substring over ALL files: 1.8 to 2.5 s. ILIKE mask: 3.2 s. Raw prefilter then per-block match: 2.5 s (9.7 s once, with another process holding 5.8 GB on the host).
- `row_number() OVER (PARTITION BY filename)` in the multi-file scan equals the single-file numbering and the physical line count on 3 of 3 files checked (2078, 2009, 2219 lines, 0 differ).
- `api-request-blob` (65559 rows, 478 MB) carries a copy of the conversation (`message.role`, `message.content`); `api-request` and `api-request-shape` carry request metadata and the system prompt. A hit there repeats a hit in the conversation.
- 14594 user entries hold `message.content` as a plain string, not a block array.
- NOT measured yet: the peak memory of the search query itself (the probe process peaked near 5 GB, but it also built an md5 table of every line), and whether DuckDB wrote the `.tmp` folder found in the repo root.

## This card: increment 1 of 4 — project-wide scope, filters, output. TypeScript only.
Files: src/cli/searchCli.ts, src/test/searchCli.test.ts (and the one-line verb summary in src/cli/main.ts if it names --session).

1. `--session` becomes OPTIONAL. Without it the search covers every transcript of the project: `<claude projects dir>/<projectSlugOf(dir)>/*.jsonl` plus `*/subagents/agent-*.jsonl`. The project dir is `--project DIR`, else the cwd (same convention as statusline-history; reuse src/projectSlug.ts and the resolver LogReader already uses for the Claude projects dir).
2. `--session ID[,ID]` narrows to those sessions (exact id or a unique prefix of 6+ chars each; an ambiguous prefix stays an error naming the candidates). With `--session` a session's subagent transcripts are included.
3. `--agent ID[,ID]` narrows to subagent transcripts whose id starts with ID. `--main-only` and `--subagents-only` (mutually exclusive).
4. `--worktrees` adds the sibling project folders whose name starts with `<slug>--claude-worktrees-`.
5. `--since T` and `--until T`: an ISO date or datetime, or a relative span `30m`, `2h`, `3d`, `1w`. Parsed and validated in JS, passed to SQL as ISO UTC strings, compared with `$.timestamp`. With either flag an entry with no timestamp is excluded. A file whose mtime is older than `--since` is not opened.
6. `--branch B` (`$.gitBranch` equal), `--cwd TEXT` (`$.cwd` contains), `--worktree NAME` (`$.cwd` contains `/worktrees/NAME`), `--model M` (`$.message.model` contains).
7. Entries of type `api-request-blob`, `api-request`, `api-request-shape` are EXCLUDED by default; `--include-requests` includes them; an explicit `--type` naming one of them also includes it.
8. Output, text mode: `<session8>[:<agent8>]<TAB>#<line><TAB><ts><TAB>[<role or type>]<TAB><excerpt>`, newest first (`--order old` for oldest first; entries with no timestamp last). `--json` adds `session`, `agent`, `file` to each hit and keeps `line, ts, type, role, excerpt` and `total`. `--count` prints `<count><TAB><session8>[:<agent8>]` per transcript, largest first. `--files` prints the matching transcript paths only. `--width N` sets the excerpt length (default 300, max 2000). `--limit` as today (default 20, max 500).
9. stderr line: how many transcripts and MB were searched, total matches, shown, ms. stdout stays matches only.
10. Engine: ONE SQL statement over the file list; `line` is `row_number() OVER (PARTITION BY filename)`. Every flag value goes through `sq()`. Before the query: `SET memory_limit` to a fixed bound and `SET temp_directory` to a fresh folder under os.tmpdir() that is removed afterwards; nothing may be written to the cwd.
11. `--role`, `--type`, `--regex`, `--limit`, `--json` and the exit codes keep today's meaning. The help example `--type tool_result` matches no top-level type; replace it with a true one.

## Acceptance
- [ ] Without `--session`, a pattern present in two main transcripts and one subagent transcript of a fixture project returns all three, each with its own true line number.
- [ ] `--session` (prefix), `--agent`, `--main-only`, `--subagents-only`, `--worktrees` each select exactly the expected fixture files.
- [ ] `--since` / `--until` (ISO and relative), `--branch`, `--cwd`, `--worktree`, `--model` each have a test with one matching and one non-matching entry.
- [ ] A hit inside an `api-request-blob` entry is absent by default and present with `--include-requests`.
- [ ] `--count`, `--files`, `--order old`, `--width` and the extended `--json` shape each have a test.
- [ ] A value containing a single quote in every string flag does not break the SQL (one test).
- [ ] Every test of today's file still passes; the one that requires `--session` is rewritten and named in the commit.
- [ ] Measured on this project and recorded here: wall time and peak RSS of one project-wide literal search with the final code, and no file or folder created in the cwd.
- [ ] `pnpm run check-types` and `pnpm run lint` clean.

## Later increments (own cards)
2 categories and element-level matching; 3 match modes (mask, fuzzy, word), `--show`, `--context`; 4 docs, skill, CHANGELOG and version.

## Approval log

- 2026-11-16T23:48:04+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

- 2026-11-16 23:49 — The .tmp folder in the repo root is dated 2026-10-03 and empty, so the probes did not create it. The probe's peak memory figure is unreliable (unit not confirmed); the acceptance box asks for a real measurement.
