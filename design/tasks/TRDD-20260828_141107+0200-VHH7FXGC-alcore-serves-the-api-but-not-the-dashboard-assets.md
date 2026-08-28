---
trdd-id: VHH7FXGC
title: alcore serves the API and SSE but not the dashboard's HTML/JS, so the web UI is dark when the Rust core is the server
column: backburner
created: 2026-08-28T14:11:07+0200
updated: 2026-08-28T14:11:07+0200
current-owner: claude-agentlenspro
task-type: feature
project-id: agentlenspro
---

# alcore serves the API and SSE but not the dashboard's HTML/JS

## What was measured

This machine moved off the `npm link` dev tree onto the published package
(`agentlenspro@2.30.1`) on 2026-08-28. Because real Rust binaries now ship inside the one
package, `src/rustBinResolve.ts` selected the native core, and the server came up as:

```
/opt/homebrew/lib/node_modules/agentlenspro/bin-native/darwin-arm64/alcore serve \
  --data-dir ~/.agentlens --otlp-port 4318 --ui-port 3000 --mcp-port 4316
```

Everything programmatic works against it — verified live, not inferred:

| surface | result |
| --- | --- |
| OTLP ingest `:4318` | 200; spans +715 and sessions +6 over 14 min |
| MCP `:4316/mcp` | 200 (`tools/list`) |
| CLI (`get_recent_sessions`) | returns live data |
| `:3000/api/summary`, `/api/server-stats` | 200 |
| log tailing | 15 282 offsets resumed, 25 900 cards restored, 5 dirs watched |

**The gap:** `rust-core/crates/agentlens-core/src/ui.rs` registers `/events` and the whole
`/api/*` family, but contains **no** `path == "/"`, no `index.html` and no `text/html`
branch. It serves the API; it does not serve the dashboard's static assets. So while
`alcore` is the server, `http://localhost:3000/` is dark — `media/dashboard.js`,
`dashboard.css` and the HTML shell have no route.

That is consistent with the intended split (Rust backend, TypeScript web UI) — the UI
*assets* simply have no server on the Rust side yet. It is a hole between the two halves,
not a defect in either.

## Why this needs a card rather than a note

The failure is silent and easy to misattribute. The server reports healthy, ingestion
continues, the CLI works, and `alcore` even prints `UI/API listening on http://127.0.0.1:3000`
— so the natural conclusion on opening the dashboard is "the server is down" or "the port is
wrong", when in fact only the asset routes are missing. Anyone bisecting that will lose time.

Note also that probing this wrongly is easy: `/api/health` and `/api/state` do not exist in
EITHER implementation, so a `curl` against invented paths returns 404 and looks like a total
outage. Probe `/api/summary`.

## Options (not yet decided)

1. **Serve the assets from Rust** — add a static-file branch to `serve_ui` for the four
   built artifacts. Smallest change; keeps one process.
2. **Keep the TS server for the UI** — run it alongside on a different port. Costs a second
   process and re-opens the one-server-per-data-dir question, so probably not.
3. **Serve the UI separately** (any static host) and point it at the Rust API.

Option 1 looks right, but the decision belongs with whoever owns the migration sequencing.

## Workaround available today

`AGENTLENS_ALCORE` (present in the installed `standalone/cli.js`) selects the core. Turning
it off and restarting falls back to the TypeScript server — still from the installed
package, so the npm transition is unaffected either way.

## Acceptance criteria

- [ ] `curl -fsS http://localhost:3000/` returns the dashboard HTML while `alcore` is serving
- [ ] the dashboard loads and renders live data end to end against the Rust core
- [ ] a test asserts the root route, so this cannot regress silently again

## Notes

Steady-state memory is worth watching separately: `alcore` settled at ~8.0 GB RSS
(5.33 → 7.72 → 7.92 → 7.99 GB over 16 min, clearly flattening) versus ~1.5 GB flat for the
TypeScript server. Not obviously a defect — it looks like the 24 h span window resident in
memory — but it is a real difference on a machine running several sessions, and nobody has
measured where it plateaus over hours.
