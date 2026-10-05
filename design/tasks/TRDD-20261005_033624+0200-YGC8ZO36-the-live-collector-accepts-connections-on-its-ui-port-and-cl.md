---
trdd-id: YGC8ZO36
title: The live collector accepts connections on its UI port and closes them with an empty reply
column: todo
status: tasked
created: 2026-10-05T03:36:24+0200
updated: 2026-10-05T03:37:30+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T03:36:24+0200
---

# The live collector accepts connections on its UI port and closes them with an empty reply

Observed 2026-10-05 03:34 to 03:36 local, read-only, by the main agent while checking three cards in `deploy`. The live alcore (pid 13922, started Sat Oct 3 17:22, binary bin-native/darwin-arm64/alcore built Oct 3 13:04, 0.1 percent CPU, RSS about 2.1 GB, elapsed 1 day 10 h) listens on 127.0.0.1:3000 (UI and REST), 127.0.0.1:4316 (MCP) and 127.0.0.1:4318 (OTLP) per `lsof -nP -iTCP -sTCP:LISTEN`. Measured with curl, one request each: port 4318 `/` returns HTTP 200; port 4316 `/` returns HTTP 404 (it answers); port 3000 `/`, `/api/server-stats` and `/api/summary` each connect and then get an empty reply (curl exit 52) in under 1 ms. `agentlenspro server status` prints "RUNNING pid=13922 — busy / not responding within 800ms (server unreachable at http://localhost:3000: socket hang up)". A request to `localhost` first tries ::1, is refused (nothing listens on IPv6), falls back to 127.0.0.1 and gets the same empty reply. So OTLP ingest and MCP answer; the dashboard and the REST API do not. NOT known: since when; whether it is every path on port 3000; the cause; what server.log says (the data directory was not read); whether a restart clears it. NOT done: no restart, no signal, nothing written to the data directory - a restart of the live collector is the owner's call. Consequence measured so far: every check that reads the REST API is unavailable, including the live step of TRDD-ZIWEB0UW and TRDD-9SOYXKNE. Done when: the cause is named from evidence, a test or probe exists that fails when the UI listener stops answering while the process stays up, and `agentlenspro server status` says something truer than "busy" for a listener that closes every connection at once.

## Approval log

- 2026-10-05T03:36:24+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Corrections 2026-10-05

CORRECTION 2026-10-05 03:40, after an adversarial review of the text above; read this before the body. (1) The title states more than was measured. Measured: between 03:34 and 03:37, from one shell, curl to 127.0.0.1:3000 got an empty reply (curl exit 52) for `/`, `/api/server-stats` and `/api/summary`, again at 03:36:45 with the request shown as completely sent, and again with `Host: localhost:3000` and an `Origin` header; `agentlenspro server status` failed the same way. That is a symptom seen for about three minutes, not yet "every connection". (2) Ruled out by reading: a by-design rejection. rust-core/crates/agentlens-core/src/ui.rs answers a refused request with HTTP 403 and a JSON body (lines 1413 to 1418), not by closing the connection. (3) NOT ruled out: a handler panic or a lock held on the UI runtime (the family of TRDD-QE114936 and TRDD-DYKJUYX3); something particular to the shell the probes ran from (unlikely, since ports 4316 and 4318 answered from the same shell); a transient state. Next read-only probes: open the dashboard in a browser; `sample 13922`; the server log. (4) "OTLP ingest and MCP answer" overstates: one GET to `/` on port 4318 returned 200 and one GET to `/` on port 4316 returned 404. Ingest itself was not exercised. (5) Disclosure: the main agent also sent one POST with body `{}` to `localhost:4318/v1/traces`; it returned no HTTP status (curl got nothing back), so whether the collector processed it is unknown. A write-shaped request to the live ingest path should not have been sent as a probe. (6) "nothing listens on IPv6" means only that a connection to ::1 port 3000 was refused. (7) "in under 1 ms" was timed for `/` only. (8) That the running process uses the binary on disk is an inference from the file's time (Oct 3 13:04) being earlier than the process start (Oct 3 17:22).
