---
trdd-id: ZIWEB0UW
title: alcore /api/server-stats lacks the capture block so status prints capture unknown
column: testing
created: 2026-09-01T19:46:50+0200
updated: 2026-09-01T20:28:24+0200
current-owner: agentlenspro-15
task-type: bugfix
---

# alcore's server-stats has no `capture` block — `server status` prints "capture: unknown"

Observed 2026-09-01 right after deploying alcore as the live server: raw body capture WORKS
(request+response JSON written to the spool seconds after boot — verified on disk), but
`agentlenspro server status` prints `capture: unknown (server predates capture reporting)`
because alcore's `/api/server-stats` JSON has no `capture` object (the TS server reported
`capture: 709 live file(s), newest 1s ago`).

Scope: port the TS server's capture stats block (live file count + newest-file age + PARKED
count/bytes, see `standalone/server.ts` grep `capture`) into `server_stats.rs`, sourcing from the
body-writers' own counters where possible rather than a directory rescan per stats call (the TS
version's scan cost is acceptable only because stats is low-frequency — measure before copying).

Also fold in the SIGBCMGL remainder if convenient: the ttl-regime resolution consulting the
statusline `prompt_cache_ttl` ground truth is a separate concern — keep it its own change.

Acceptance: `agentlenspro server status` against a live alcore prints a real capture line;
mutation check — zeroing the counter changes the line.

## STATE — 2026-09-01 — SHIPPED (`0c19090d`), one gauge remaining

`bodies.live {files,newestMs}` shipped and verified end-to-end against the live server
("328 live file(s), newest 1s ago"). Cargo gates 0/0/0, mutation-tested. The same deploy
exposed and fixed the TS-resurrection gap (hook-revive + setup spawning server.js
unconditionally — both now engine-parity via alcoreBin()).
REMAINING BOX: `bodies.parked` gauge (TRDD-8TM7I49X ts-row-mismatch park) is not in alcore's
block yet, so the PARKED suffix is silently omitted from `server status`. Port it the same way
(counter or bounded scan mirroring the TS semantics), then → ai_review.
