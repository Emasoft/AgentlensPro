---
trdd-id: RWDUGF12
title: One invalid parquet file in store api_calls blinds investigate_burn and the blind note blames the bodies dir
column: todo
status: tasked
created: 2026-11-19T04:39:02+0100
updated: 2026-11-19T05:26:58+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T04:39:02+0100
---

# One invalid parquet file in store api_calls blinds investigate_burn and the blind note blames the bodies dir

MEASURED in the 2.34.0 isolated run (reports_dev/iso-run/20261119_033859+0100/driver.log lines 36, 50, 52): the driver wrote a 4-byte file store/api_calls/part-abc.parquet (content 'test', scripts_dev/iso-run-2.34.0.mjs:451) before phase B. Phase A investigate_burn on the same window read 30055 responses store-first (line 36 coverage); phase B returned BLIND with 0 rows for BOTH probe windows, including the window whose parts were kept (lines 50, 52). Read by the main agent: agentlens_store::parquet_scan (agentlens-store/src/lib.rs:290-320) lists every *.parquet name in the dir into one read_parquet([...]) call, so one unreadable file fails the whole query; load_store_window (agentlens-core/src/burn/investigator_scan.rs:376-400) returns None on any prepare/query error; the scan then reports blind no-bodies-dir (:622-625), a note that says ~/.agentlens/otel-bodies is missing and tells the user to run agentlenspro setup, which is not the cause. Needed: (1) the blind note names the store read error when the store load failed; (2) decide whether a part that does not open is skipped and reported (with its name) or fails the reader closed, and apply the same rule to every parquet_scan caller. Pre-existing; not caused by the api_calls purge (TRDD-OBJ4FK2T).

## Approval log

- 2026-11-19T04:39:02+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-11-19T05:26+0100 main agent MEASURED SILENT WRONG ANSWER on the 2.34.0 build (isolated readers run reports_dev/iso-run/20261119_051611+0100, driver.log and server-readers.log read by the main agent): on an intact store (no purge had run yet; the purge line came at 05:19:04+0100) investigate_burn for the window ending 2026-10-21T12:20:31Z returned resp 0, calls 0, blind no-bodies-dir and a BLIND note (no store-first prefix) at 04:18:30Z, while DuckDB on the same copy counts 112010 response rows there and the same server answered store-first 63953 for another window 27 s later. load_store_window turns every DuckDB error into None (investigator_scan.rs:376-420), so the error is not visible; the server was at memory pressure stage 3 at that time. Same verdict family as TRDD-TGOT9OOX (an empty purged window).
