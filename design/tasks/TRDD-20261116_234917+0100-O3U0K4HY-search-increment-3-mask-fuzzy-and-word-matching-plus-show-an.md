---
trdd-id: O3U0K4HY
title: search - increment 3 mask fuzzy and word matching plus show and context
column: backburner
status: tasked
created: 2026-11-16T23:49:17+0100
updated: 2026-11-16T23:49:17+0100
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
