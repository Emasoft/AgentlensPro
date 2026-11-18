---
trdd-id: JLEIOR7A
title: disable must switch off only telemetry and the event-hook logs - every CLI verb keeps working
column: superseded
status: archived
created: 2026-11-18T00:58:01+0100
updated: 2026-11-18T00:58:45+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T00:58:01+0100
superseded-by: [RBBEX59R]
---

# disable must switch off only telemetry and the event-hook logs - every CLI verb keeps working

OWNER DIRECTIVE, 2026-11-18 (verbatim, two messages): «i told you that disable must disable only telemetry and event hooks logs, not jsonl parsing by duckdb or statusline hook or adversarial/measurer review hook!» and «the agentlenspro cli must work just the same, only with less informations since the telemetry is missing or has holes». Said after the owner asked for the search command («is the command to search the sessions jsonl files with duckdb ready? i need it asap») and the main agent answered that search refuses while ~/.agentlens/DISABLED exists.

## What the code does today (read by the main agent on 2026-11-18, src/cli/foreignTelemetry.ts 28-116)
disabledNotice returns a refusal (EXIT.DISABLED) for every verb that is not in HOOK_PATH_VERBS, READ_ONLY_VERBS or DISABLED_PASSTHROUGH and is not get_account_status --all. READ_ONLY_VERBS held: cache-expired, cache-state, last-compact, model-headroom, statusline-history, disk-sample, disk, disk-watch, disk-monitor. So search, and every other verb of the dispatch switch and every server diagnostics tool, was refused. NOT read: what the hook-path verbs (hook, gate, review-gate, review-supervisor, delegate-gate, statusline) do when the flag is armed; the doc comment says they «handle the switch themselves».

## Increment 1 (in flight)
search joins READ_ONLY_VERBS (no DISABLED stop, no launch self-heal), the bundle is rebuilt, the bare command is run with the flag armed. Evidence folder: reports_dev/G2GGBQ0U/gate-20261118_005720+0100.

## Acceptance
- [ ] search runs with the flag armed (bare command, exit 0, no DISABLED text), and a test fails when it is gated again.
- [ ] Every verb of the dispatch switch is listed with what it does while disabled today, and each one that only reads files (transcripts, the stores, the status-line feed) runs.
- [ ] The verbs that ask the running server answer with what exists without telemetry (less information), or say plainly that the server is not running; none says «DISABLED, did not run». The design for this is written here before it is built.
- [ ] The statusline hook and the review hooks (review-gate, review-supervisor, the review mod) are shown to work with the flag armed; what disable switches off is exactly telemetry and the event-hook logs, and that list is in the help of disable.
- [ ] The cards that were parked as waiting on the flag (TRDD-UIQS9RXZ box 8, TRDD-G2GGBQ0U) are re-read and their boxes run.

## Approval log

- 2026-11-18T00:58:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T00:58:45+0100 — SUPERSEDED by main-agent@agentlenspro. minted by the main agent on 2026-11-18 without first searching the cards: TRDD-RBBEX59R (2026-11-03) already owns this directive and its increment (d) removes the verb refusals.
