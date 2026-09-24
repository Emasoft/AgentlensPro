---
trdd-id: JJLI6GEH
title: A DuckDB OOM in the boot card restore crash-looped alcore through hook-revive for most of two weeks
column: todo
status: tasked
created: 2026-09-24T19:26:52+0200
updated: 2026-09-24T19:39:56+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-24T19:26:52+0200
---

# hook-revive spawns tens of thousands of alcore boots that load the span store before the pid lock

OWNER-ADJACENT evidence, orchestrator, 2026-09-24, measured over the whole ~/.agentlens/server.log: 40,735 "boot provenance" lines total, 40,731 of them started-by=hook-revive. Of those, 40,316 are immediately followed by a "loaded N span(s)" line (the span store is loaded into memory) and only 201 are followed by an explicit "Refusing to start: another AgentlensPro server ... owns this data directory" pid-lock refusal. So hook-revive is spawning tens of thousands of alcore processes that load the span store before, or instead of, meeting the pid lock that is supposed to keep exactly one server owning the data directory (pid_lock.rs claim/release, keyed on data dir, per CLAUDE.md). Open question to answer FIRST: does the pid-lock check run strictly after the span-store load in the boot sequence (so every one of the ~40k non-refused boots genuinely loaded the store before being told to exit, wasting the load and creating a window where two processes both hold the store in memory), or is "loaded N span(s)" logged by a process that then exits cleanly on the lock check with no dedicated refusal line (making the 201:40316 ratio not a measure of contention at all)? Read pid_lock.rs::claim and the alcore.rs boot sequence in order before proposing a fix. Related: TRDD-WKLD508O (this card documents hook-revive as the restart mechanism with no supervisor).

## Approval log

- 2026-09-24T19:26:52+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

2026-09-24T19:37:34+0200 -- The pid lock runs BEFORE the span load (alcore.rs:192 vs :227): this card's original open question is answered and its premise refuted (see reports/JJLI6GEH/20260924_193521+0200-boot-storm-investigation.md, read in full). Real chain: a failed hook POST (server dead/unreachable) triggers reviveDaemonDetached() (src/cli/hookHandlers.ts), gated only by a 15s file-lock debounce with no health probe -> the new alcore wins the pid lock via dead-takeover (pid_lock.rs::claim, prior pid not alive) -> the synchronous boot sweep (log_reader::start_sweeper, runs before any listener binds) bulk-upserts session cards into card_store's DuckDB handle hard-capped at memory_limit=256MiB (card_store.rs:82) against a 238MB on-disk cards.duckdb -> the upsert .expect() panics on a DuckDB Out-Of-Memory error (card_store.rs:168) -> start_sweeper maps the dropped boot_tx channel to Err("log-sweeper died during the boot sweep") (log_reader.rs:1411) -> alcore.rs exits(1) (alcore.rs:291-294) before ever binding a listener. MEASURED over the whole ~/.agentlens/server.log (335,230 lines at investigation time): 40,735 boot-provenance lines, only 53 (about 0.13 percent) ever printed a listening line; the first refusal is at line 2,433 of 335,161, i.e. near the very start of the log's 14-day span, so the crash loop ran for most of that span until it stopped on its own. Verified by line-number re-check (this update): the last crash-loop panic sits around server.log line 324,018, a manual server-restart boot at line ~324,027 succeeds (restores 31,165 session cards, then binds listeners), and all 48 RSS-HARD-CAP exits (TRDD-WKLD508O) sit strictly after that line (0 before, 48 after) -- i.e. they belong entirely to the healthy tail, not the crash loop. Two defects to fix, tracked below.

## Fixes needed

- [ ] (a) A DuckDB error in the boot-time card restore must not panic the process (card_store.rs:168's .expect on the upsert) -- propagate it as a recoverable Result instead, and size memory_limit (card_store.rs:82, currently 256MiB) to the actual store; the same undersized limit also caused TRDD-TWDGR75R's cards_json OOM.
- [ ] (b) hook-revive (src/cli/hookHandlers.ts::reviveDaemonDetached) needs crash-loop backoff -- after N consecutive boots that die before ever binding a listener, stop reviving and surface a status line instead of relaunching every ~15s forever.

## Open questions

What ended the storm is UNKNOWN -- server.log carries no per-line timestamps. Candidates, none checked: a deploy that day, cards.duckdb being rebuilt/vacuumed, or a card_store code change. Also open: whether spans/cards for the 2026-09-10 -> end-of-storm window are recoverable by re-scanning the local Claude/Codex/Copilot transcripts -- OTLP-only data from that window was never ingested, since the boot sweep never got far enough to start the OTLP listener.
