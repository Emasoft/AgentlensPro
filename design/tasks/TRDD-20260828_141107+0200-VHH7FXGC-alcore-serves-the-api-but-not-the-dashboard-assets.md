---
trdd-id: VHH7FXGC
title: alcore serves the API and SSE but not the dashboard's HTML/JS, so the web UI is dark when the Rust core is the server
column: complete
created: 2026-08-28T14:11:07+0200
updated: 2026-08-28T21:55:03+0200
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

## This is NOT a scope decision — TRDD-DMWOBWFH already decided it

An earlier revision of this card offered three options and handed the choice to whoever owns
the migration. **That framing was wrong and is retracted** (USER, 2026-08-28): it invited a
re-decision of something the migration plan settles explicitly. TRDD-DMWOBWFH's scope
section reads:

> **TypeScript keeps**: `media/src/**` (Preact dashboard — unchanged), the thin CLI shell
> may remain TS initially… **Parity law**: the wire protocol and the on-disk formats are the
> compatibility boundary — **the dashboard and existing data must work unmodified against
> either core.**

So TypeScript keeps the dashboard's *Preact source*; SERVING the built assets is the Rust
core's job, and the parity law requires the dashboard to work unmodified against alcore.
Keeping a second TS server, or hosting the UI elsewhere, both contradict that. **The only
conforming outcome is a static-asset route in `serve_ui`.**

**Why the gap exists** (worth recording, because it is not an oversight anyone made): P4e
ported the UI listener against a FROZEN wire contract, slice by slice. `ui.rs`'s own module
doc enumerates what it reproduces — CORS, the viewer gate, CSRF, `GET /api/summary`,
`/events`, and `fallback → 404, NO Content-Type, body "Not found"`. The freeze list was
built from the `/api/*` + MCP contract, and static assets are not part of that contract, so
they were never a slice. The port is still walking that list (P4x: 21 of 53 tools).

## Workaround available today

`AGENTLENS_ALCORE` (present in the installed `standalone/cli.js`) selects the core. Turning
it off and restarting falls back to the TypeScript server — still from the installed
package, so the npm transition is unaffected either way.

## Acceptance criteria

- [x] `curl -fsS http://localhost:3000/` returns the dashboard HTML while `alcore` is serving
- [x] the dashboard loads and renders live data end to end against the Rust core
- [x] a test asserts the root route, so this cannot regress silently again

## Done — 2026-08-28 (version 2.31.0)

**Shape (advisor-confirmed, Fable 5):** the 540-line `getHtml` literal moved to **`media/index.html`**
with six `@@TOKENS@@`; `server.ts::getHtml` reads and substitutes it (function replacements — a
string replacement interprets dollar-patterns in the inlined JSON, and that trap bit the first
edit), and `ui.rs::dashboard_html` does the same on the Rust side. One template, two servers —
the alternative was a Rust copy that `check-no-mirrors` cannot see. `static_asset` ports the MIME
map and containment (`Path::starts_with` is component-wise, i.e. the TS's `mediaDir + sep`).
`alcore serve` requires `--media-dir` and refuses to boot without `index.html` there;
`serverControl.findMediaDir()` resolves it by the same layout walk as `findServerJs`.

**Evidence, all measured on isolated instances (never the live :3000):**

- TS `getHtml` before/after: byte-identical on fixed inputs (`old==new: true`, 28411 bytes),
  including a payload carrying `$&`, `$1` and `<\/`.
- alcore vs TS `GET /`: identical after normalizing the 3 inlined data lines; both send
  `text/html`, `Vary: X-Agentlens-Viewer`, the loopback `frame-ancestors` CSP. `/dashboard.js`
  200 `application/javascript` 758388 bytes from both. `/../package.json` → 404, bogus viewer
  header → 403 on alcore.
- Headless Chrome against alcore with one OTLP-seeded session: `{"sessionRows":1,"errors":[]}`,
  sidebar Active, screenshot `reports/screenshots/20260828_214317+0200-alcore-dashboard.png`.
- Tests: `tests/ui.rs` +1 (`root_serves_the_dashboard_shell_and_static_assets_stay_contained`:
  both routes, headers, tokens all substituted, build id = the update frames' id, restricted meta
  absent for standalone, static 200, and four refusals incl. the `<media>-assets` sibling and a
  `..` escape); 40/40 in the file; cutover suite 7/7 (`--media-dir` asserted, real alcore boots).
  `check-types`, `lint`, `clippy --all-targets`, `check-mirrors`, `check-dist-contents`,
  `check-identities` clean; `media/index.html` confirmed in `npm pack --dry-run`.

**Not done here (own cards):** the restricted-viewer meta-tag path is exercised only by the
`restricted` boolean plumbed from the existing verified gate — no signed-header test for `/`;
the P9 browser smoke suite still boots `server.js` only. `standalone/server.js` stays in `files`
until DMWOBWFH box 3 drops it.

## Notes

Steady-state memory is worth watching separately: `alcore` settled at ~8.0 GB RSS
(5.33 → 7.72 → 7.92 → 7.99 GB over 16 min, clearly flattening) versus ~1.5 GB flat for the
TypeScript server. Not obviously a defect — it looks like the 24 h span window resident in
memory — but it is a real difference on a machine running several sessions, and nobody has
measured where it plateaus over hours.
