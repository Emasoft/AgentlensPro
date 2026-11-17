---
trdd-id: O3U0K4HY
title: search - increment 3 mask fuzzy and word matching plus show and context
column: dev
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-17T10:20:54+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T23:49:17+0100
---

# search - increment 3 mask fuzzy and word matching plus show and context

Increment 3 of 4 of the owner's 2026-11-16 search request (quoted in full on TRDD-UIQS9RXZ). Needs increments 1 and 2. TypeScript only: src/cli/searchCli.ts, src/test/searchCli.test.ts.

## Plan
1. Match modes, mutually exclusive, default literal case-insensitive substring:
   - `--regex` (today's).
   - `--mask`: `*` = any run of characters, `?` = one character; translated to ILIKE with `%`, `_` and the escape character escaped.
   - `--word`: the pattern as a whole word (regex with word boundaries, pattern regex-escaped).
   - `--fuzzy`: the pattern is split on spaces into words; an element matches when EVERY word is present, in any order, case-insensitive; a word of 5 or more characters also matches with ONE character substituted, deleted or inserted (a generated regex alternation per word). Transpositions are not covered; say so in the help. Hits are ordered by how many words matched exactly, then by time.
2. `--case` makes literal, mask and word matching case-sensitive.
3. `--show <session>:<line>` prints ONE entry in readable form (each element's kind and text), bounded by `--max-chars N` (default 4000, max 100000), so an agent can fetch exactly the entry a hit named. No pattern needed.
4. `--context N` (max 5) prints the N entries before and after each hit of the same transcript, one line each, marked as context.
5. Before promising `--fuzzy` in the help, time it on this project (3.15 GB); if it exceeds 15 s, the help must say that it needs a scope flag.

## Acceptance
- [ ] `--mask` with `*`, `?` and a literal `%` and `_` in the pattern.
- [ ] `--word` does not match inside a longer word.
- [ ] `--fuzzy`: words in another order match; one substitution, one deletion and one insertion in a 6-letter word match; two edits do not; a 4-letter word needs an exact match.
- [ ] `--case`.
- [ ] `--show` prints the full text of the named entry and refuses an unknown session or line with exit 2.
- [ ] `--context 1` prints the neighbour entries and never crosses into another transcript.
- [ ] Two mode flags together are a usage error (exit 64).
- [ ] Measured on this project and recorded here: wall time of a two-word `--fuzzy` search, project-wide.
- [ ] check-types and lint clean.

## Approval log

- 2026-11-16T23:49:17+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Added by the review of TRDD-UIQS9RXZ

2026-11-17T02:25+0100 main agent: this increment also adds three tests the review of TRDD-UIQS9RXZ found missing: (1) a search with --worktrees returns the hit inside the worktree transcript (fixture line 'wt NEEDLE'), with its true line; (2) a search with --agent returns only the sub-agent hit; (3) a search run from an empty working directory leaves that directory empty.
2026-11-17T10:17+0100 main agent: moved backburner -> todo and DISPATCHED to a worker (sonnet) at HEAD 3c9ec3d7, after the text-content change of TRDD-OIMXULDJ was committed (37e538fc) and the two search files were clean. The worker may edit only src/cli/searchCli.ts and src/test/searchCli.test.ts; it keeps a BEFORE build in builds_dev/o3u-out-before, must show 0 differing transcripts on three before/after counts over the frozen set, times --fuzzy, and reports to reports_dev/O3U0K4HY/. On its handback the main agent reads the report and the diff whole, reruns the test file, types, lint and one comparison on the build of the final source, and only then commits the two files by name and ticks boxes. A second, read-only worker audits the eight unticked boxes of TRDD-OIMXULDJ against copies of the committed files in tests_dev/OIMXULDJ/. No other worker edits the two search files meanwhile.
2026-11-17T10:20+0100 main agent: column set to dev (a worker is implementing; the earlier move to todo discarded the tool output, this one was kept: "O3U0K4HY -> column dev"). The docs commit b43e99ed landed after the worker was told HEAD 3c9ec3d7; the two source files are the same in both.
