---
trdd-id: ZIWEB0UW
title: alcore /api/server-stats lacks the capture block so status prints capture unknown
column: ai_review
created: 2026-09-01T19:46:50+0200
updated: 2026-09-05T08:13:10+0200
current-owner: agentlenspro-15
task-type: bugfix
---

# alcore's server-stats has no `capture` block — `server status` prints "capture: unknown"

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

**This card's acceptance is PROSE, not checkboxes** — `board-boxes.sh` flags it `NO BOXES (and NO
criteria heading — REVIEW)`. That is not "nothing to verify": the claims were extracted from the
prose and each was checked.

**OBSERVED BY THE ORCHESTRATOR:** `curl -s localhost:3000/api/server-stats` on the running server
returns `bodies` with keys `[archive, lastPass, live, parked, spool]` and
`live: {files: 29, newestMs: …}`. The capture block IS on the wire, checked at the response rather
than by reading the serializer that builds it. (That this satisfies the card's PROSE criteria is
the agent's extraction, not mine — I read the symptom and scope paragraphs, not the full criteria
set.)

**REPORTED BY THE REVIEWING AGENT:** the `unknown (server predates capture reporting)` message is
gated only on an ABSENT `live`, and the mutation tests pass. Report:
`reports/ai-review/20260905_081231+0200-ZIWEB0UW.md`.

**The same response is CORROBORATION for a different card, and no more than that**:
`captureDownSince` is ABSENT from that `bodies` object, which TRDD-U0L78B3Z predicts. But the curl
was taken while capture was healthy — the state in which a correctly working implementation would
ALSO omit an optional field — so it discriminates nothing. U0L78B3Z rests on the source absence,
as it did before. Recorded here because this is where the observation was made, and marked for
what it is so nobody upgrades it.

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

PARKED GAUGE SHIPPED (`3b7bfcd6`) and verified live: the status line prints the full TS-parity
capture line including 'PARKED 307 file(s) 144.3MB'. Both acceptance criteria met → ai_review.
Deploy lesson captured as ATOM-SFLG-1NSX (in-place cp SIGKILL).
