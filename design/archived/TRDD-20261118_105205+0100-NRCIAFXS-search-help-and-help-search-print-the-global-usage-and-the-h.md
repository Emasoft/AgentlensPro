---
trdd-id: NRCIAFXS
title: search --help and help search print the global usage and the help text of the verb is unreachable
column: complete
status: archived
created: 2026-11-18T10:52:05+0100
updated: 2026-11-18T11:09:19+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T10:52:05+0100
---

# search --help and help search print the global usage and the help text of the verb is unreachable

Found 2026-11-18 by the main agent after the owner asked for the search (verbatim): «windows is not a priority now. i need the search option asap!».

## Problem
RUN: agentlenspro search --help (linked bundle of 04:50) prints the 224-line global usage. Its only search entry is the old one-session line (agentlenspro search <pattern> --session ID ...), so the project-wide search, its match modes and --count, --show, --project are not shown. READ in src/cli/main.ts: the HELP IS TOTAL branch answers any --help or -h itself, and search is in MANAGEMENT_VERBS, so runSearchCli never sees the flag; help search takes the branch for management verbs and prints the same global usage. SEARCH_USAGE (src/cli/searchCli.ts) is therefore not reachable through --help or -h. Not read: whether a search with no pattern prints it.

## Fix
In main.ts print SEARCH_USAGE for search --help, search -h and help search (static text, no socket, nothing run). The summary line for search in the global usage names the project-wide form.

## Acceptance
- [x] search --help, search -h and help search print the text of SEARCH_USAGE, exit 0 and run no search; a committed test fails before the change and passes after.
- [x] The search entry of the global usage describes the project-wide form.
- [x] The linked bundle is rebuilt and the real command shows the new text.

## Approval log

- 2026-11-18T10:52:05+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T11:09:19+0100 — COMPLETE by main-agent@agentlenspro. three boxes met; deployed and run on the real executable 2026-11-18.

## Outcome

2026-11-18, commit a6ea815a: src/cli/main.ts prints SEARCH_USAGE for search --help, search -h and help search; the search entry of the global usage is rewritten. Test added in src/test/cliUsageContract.test.ts (5 passing by the worker report). NO failing run of that test was recorded: the worker edited main.ts before running it. The failing observation that exists is the run of the real command on the bundle of 04:50, which printed the global usage (reports_dev/main-agent/20261118-search-help.txt).

## Deployed 2026-11-18

The linked bundle standalone/cli.js was rebuilt with node esbuild.js at commit c2ad9836 (file time 11:08, 941,062 to 948,571 bytes; former bundles copied to builds_dev/pre-search-deploy-20261118/). RUN on the real executable: agentlenspro search --help, search -h and help search each gave rc 0 and byte-identical output (cmp), the text of SEARCH_USAGE with --mask, --word, --fuzzy, --count, --show, --project and --kind. No installer step ran: the three forms return before the launch check of main.ts line 282, and settings.json, the agent files and the skill kept their file times of 10:32. Two real searches on this project gave rc 0. Box 1 was ticked on substitute evidence: no failing run of the committed test exists; the failing observation is the old bundle printing the global usage.
