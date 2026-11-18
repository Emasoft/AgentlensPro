---
trdd-id: ETFX9JFM
title: cache-expired and cache-state cannot answer with no server once the newest sample is only in a sealed part
column: todo
status: tasked
created: 2026-11-18T03:24:59+0100
updated: 2026-11-18T03:24:59+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T03:24:59+0100
---

# cache-expired and cache-state cannot answer with no server once the newest sample is only in a sealed part

## Why

Found while closing TRDD-VS1FCUMU (2026-11-18). Both verbs read the newest status-line sample through authoritativeFromWals (src/cli/cacheExpiredCli.ts 128-181 on feat/rbbex59r-c2), which reads only the wal-*.ndjson files of the two newest day directories and no parquet part; for a sample that is only in a part the verbs ask the server.

RUN by the main agent 2026-11-18 03:18 on an isolated store with no server (raw output reports_dev/VS1FCUMU/cacheverbs-raw/, files 6 to 9): one sample in wal-cli.ndjson: cache-expired printed false and cache-state printed warm, exit 0. After alcore statusline-seal turned that file into a part: cache-expired exit 2 (cannot reach the server), cache-state exit 2 (no status-line sample with a prompt_cache block), while statusline-history sessions still listed the session.

So with the server kept down, an IDLE session whose last sample has been sealed gets no answer, and an idle session is the case cache-expired exists for. Owner, 2026-11-18 (verbatim): «the agentlenspro cli must work just the same, only with less informations since the telemetry is missing or has holes».

Second cost of the same reader, from code and the live inventory, not timed: every call reads each write-ahead file of the two newest days whole and parses every line. On the live store of 2026-11-18 that was 307.2 MiB plus 25.0 MiB for the main stream.

## Options (not decided)

1. When no write-ahead row matches and no server answers, read the newest parts of the two newest days through the DuckDB reader the CLI already ships (queryStatusline).
2. The sealer keeps the newest sample of each session in a small side file that the verbs read first.

## Checklist

- [ ] Decide the option on a measured cost (cold start of DuckDB in the CLI against the size of a side file)
- [ ] Test: sample only in a part, no server, both verbs answer
- [ ] Bound the read of large write-ahead files (stream from the end, or stop at the first row older than the newest match)

## Approval log

- 2026-11-18T03:24:59+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
