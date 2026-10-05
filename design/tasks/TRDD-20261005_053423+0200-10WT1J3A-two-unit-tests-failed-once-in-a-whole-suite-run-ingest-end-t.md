---
trdd-id: 10WT1J3A
title: Two tests failed once in a whole-suite run on 2026-10-05 - cause unknown
column: todo
status: tasked
created: 2026-10-05T05:34:23+0200
updated: 2026-10-05T05:37:35+0200
current-owner: main-agent@AgentlensPro
created-by: main-agent@AgentlensPro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@AgentlensPro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@AgentlensPro
approval-datetime: 2026-10-05T05:34:23+0200
---

# Two tests failed once in a whole-suite run on 2026-10-05 - cause unknown

Seen once, on 2026-10-05 at about 05:21 to 05:27 (from file times), in a whole-suite mocha run started by accident (a worker ran `mocha <file>` with the config, which runs every spec): 3044 passing, 11 pending, 2 failing, exit 2. Output kept in gitignored docs_dev/owed-mocha-agentGate.txt.

Failing test 1, the subject of this card: "ingest end to end - the CLI start path with a real alcore". AssertionError: no spooled line within 90 s. The stats printed by the test show rejectedInvalid 1, a hook/session_start record rejected for the fields cwd, source, transcript_path, and linesWritten 0. (First written from the worker's report; both failure blocks were read by the main agent afterwards, see Evidence read 2026-10-05.)

Failing test 2, carried here as a lead: "hook spool - a live revived child is reaped (isolated subprocess)". AssertionError: no live child was ever revived (revivedPid null, reaped false).

Not known: whether either fails when its file is run alone; whether the test drives the installed bundle (standalone/cli.js, built 2026-10-01) against a newer debug alcore, which would make this a version mismatch and not a defect in either. A rejection that names fields does not look like a timing effect.

Acceptance:
- [ ] Each of the two tests is run alone once (`mocha --no-config --require src/test/setup.js --ui tdd --timeout 10000 <file>`), at a load average below 20, and the result recorded here.
- [ ] The whole suite is run once with no other suite running and the result of these two tests recorded here.
- [ ] The cause of each failure is named with the line that shows it, or this card states what was tried and stays open.

## Approval log

- 2026-10-05T05:34:23+0200 — MANDATE issued by main-agent@AgentlensPro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence read 2026-10-05

- Read first-hand by the main agent in the kept output (2026-10-05), failure 1: `hook spool — a live revived child is reaped (isolated subprocess)`, AssertionError `no live child was ever revived (harness result: {"phase":"done","revivedPid":null,"reaped":false, ...})`, at out/test/test/hookSpool.test.js line 313.
- Read first-hand, failure 2: `ingest end to end — the CLI start path with a real alcore`, case `AGENTLENS_INGEST=on: tap is ON, default sources, a hook event is spooled, ingest/ exists; stop reaps the child`, AssertionError `no spooled line within 90 s` with stats `"linesWritten":0`, `"rejectedInvalid":1`, `"rejectedByTopic":{"hook/session_start":1}`, and rejectedFields for hook/session_start beginning `"cwd","source","tran` (the line is cut there in the capture), at out/test/test/ingestEndToEnd.test.js line 149. That the rejection caused the missing spooled line is not shown.
- On overlap: the failing run's output is complete (summary present, 6 minutes, file time 05:27); the second run's output stops inside the ingest end to end test with `server started (pid 32797)` and file time 05:29. So the second run very probably began after the failing run ended, and competing runs probably do not explain the failures. Inferred from file times and contents.
- Also not known: whether either failure depends on the state of the live collector, whose UI port was returning empty replies that morning (TRDD-YGC8ZO36); both tests exercise the CLI start and revive path, the ground of TRDD-L6V1UUW0. Order dependence inside the suite is possible too (compare TRDD-B7DSTJLS), so a pass when run alone would not clear either test.
