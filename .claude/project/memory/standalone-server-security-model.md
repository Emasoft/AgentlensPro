---
name: standalone-server-security-model
description: "can a website read my local agentlens data / is the dashboard server exposed / cross-origin CORS localhost security / why does a POST from another origin get 403 / drive-by localhost exfiltration / ACAO wildcard vs scoped / how is the standalone server protected against a browsed page / CSRF on the local server"
ocd: 2026-07-11
lmd: 2026-07-11
metadata:
  node_type: memory
  tier: component
  type: project
  globs: ["standalone/server.ts"]
---

The standalone server exposes a UI/API server (`UI_PORT`, default 3000) and an OTLP
receiver (`OTLP_PORT`, default 4318). Its threat model is NOT a remote attacker (it binds
`127.0.0.1` by default, unreachable from the network) but a **web page the user is
browsing**, which can reach `localhost` from the user's own browser. Three layers defend
the local data (all in `standalone/server.ts`, `uiServer`):

1. **Loopback bind** (`BIND_HOST`, default `127.0.0.1`) — no network exposure unless the
   user opts into `0.0.0.0` for LAN.
2. **CSRF write gate** (`isDisallowedCrossOrigin`, guards non-GET/HEAD) — several handlers
   turn request fields into filesystem writes (`/api/instructions/apply`,
   `/api/bodies/export`, `/action`), so a cross-origin browser POST was an arbitrary-file-
   write → RCE vector. The gate refuses any state-changing request whose `Origin` is
   present and neither same-origin nor loopback. CLI/hook Node clients send no Origin →
   allowed.
3. **CORS read scope** (`setAllowedOriginCors`, TRDD-F6BM1BDI, shipped v2.4.0) — the read
   endpoints (`/api/summary`, `/api/sessions`, `/api/session/*`, `/api/debug/*`) return
   session data (prompts, costs, file paths). The server now echoes
   `Access-Control-Allow-Origin` ONLY for same-origin/loopback origins (+ `Vary: Origin`),
   never the wildcard — so a cross-origin page gets no CORS header and the browser blocks
   it from reading the response. Reuses the layer-2 predicate (one place decides "allowed
   origin").

The OTLP receiver (`otlpServer`) sets NO CORS header — it is reached server-to-server by
agent SDK exporters, never a browser.

## Notes and lessons learned
[^1]: [ocd:2026-07-11 lmd:2026-07-11] The round-1 review added the CSRF WRITE gate but
  left `Access-Control-Allow-Origin: *` on responses with the comment "read endpoints are
  non-sensitive" — false: they carry the user's prompts/costs/paths, so `*` was a
  cross-origin READ-exfil hole (the read counterpart to the write vector). Lesson: a CSRF
  write gate and a CORS read policy are SEPARATE controls — closing writes does not close
  reads; scope ACAO explicitly. GET being CSRF-ungated is justified by "no write side
  effect", NOT by "the data is non-sensitive".
