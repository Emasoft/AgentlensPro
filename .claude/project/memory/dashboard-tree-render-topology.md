---
name: dashboard-tree-render-topology
description: "where does the session timeline / waterfall / flow tree render in the dashboard / I added a button to Traces.tsx or Flow.tsx but it's invisible / there is no Traces or Flow tab in the UI / which component actually shows the subagent tree"
ocd: 2026-07-12
lmd: 2026-07-12
metadata:
  node_type: memory
  tier: component
  type: project
---

The dashboard has **no `Traces` tab and no `Flow` tab**. `App.tsx` `TABS` + `ActivePanel`
(media/src/App.tsx ~L38-62) render only: `sessions`, `context`, `cache`, `history`, `analytics`,
`patterns` (Advisor), `export`, `import`, `help`. `Traces()` and `Flow()` top-level exports exist
but are **dead** (no `<Traces/>` / `<Flow/>` render path).

The session tree the user actually sees is **expand-in-place inside the Sessions tab**. `Sessions.tsx`
`SessionDetail` has a sub-section bar (`Overview | Trace | Flow | Tools | Files`, a `section` useState)
and renders, from Traces.tsx/Flow.tsx, only these reusable pieces:
- `section === 'trace'` → `<TimelineWaterfall …>` (Sessions.tsx ~L398) — this is where the timeline
  steps AND the **subagent tree** live (`SubAgentBranch`, Traces.tsx ~L1098, recurses back into
  `TimelineWaterfall`). `SessionBlock` (the Traces-TAB session wrapper) is NOT used here — it's dead.
- `section === 'flow'` → `<FlowCanvas sess=… height=…>` (Sessions.tsx ~L406) — the canvas flow view.
  (`FlowCanvas` is a `<canvas>`: its internal `SemNode` drops spanId/requestId, so per-node DOM
  buttons are impossible there; only a toolbar-level button fits.)

So to add a per-session/per-branch UI affordance, mount it in **Sessions.tsx** (section bar, for the
whole session) and/or **`SubAgentBranch`** (subagent) and/or **`FlowCanvas` toolbar** — never in
`SessionBlock` or the `Traces()`/`Flow()` top-level functions.[^1] Children source for the subagent
tree: `sessionSummary.value.sessions` filtered by `parentSessionId === id && sessionId !== id`.

Live UI = the built `media/dashboard.js` bundle, served static by the standalone server. A **running**
server keeps the OLD bundle in memory across a rebuild — a browser reload picks up a rebuilt
dashboard.js, but a NEW server route (e.g. an `/api/*` endpoint) needs the server **process restarted**
(`agentlenspro server restart` / `deploy:safe`). See [[agentlenspro-publish-pipeline]],
[[always-on-ingestion-model]].

## Notes and lessons learned
[^1]: [ocd:2026-07-12 lmd:2026-07-12] TRDD-4CH9QLAH (copy-branch ⧉ tree button) first wired the button
  into `SessionBlock` (Traces tab) + `SubAgentBranch` + the Flow toolbar, then dev-browser found the
  SessionBlock mount was invisible because the Traces tab doesn't exist. Lesson: the file name
  (`Traces.tsx`/`Flow.tsx`) is NOT the render surface — verify the actual `ActivePanel`/`SessionDetail`
  render path before mounting UI, and prefer a live dev-browser check to confirm the element renders.
