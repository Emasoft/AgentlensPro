---
name: dashboard-tree-render-topology
description: "where does the session timeline / waterfall / flow tree render in the dashboard / I added a button to Traces.tsx or Flow.tsx but it's invisible / there is no Traces or Flow tab in the UI / which component actually shows the subagent tree"
ocd: 2026-07-12
lmd: 2026-09-08
metadata:
  node_type: memory
  tier: component
  type: project
publish-globally: false
---

^JU2HIIL9 [desc:"the dashboard has no Traces/Flow/Cost tab — those top-level exports are tree-shaken dead code; only 8 real tabs exist in App.tsx TABS", keywords:"no_traces_tab_in_dashboard no_flow_tab_in_dashboard no_cost_tab_in_dashboard dead_top_level_export tree_shaken_by_esbuild which_tabs_actually_render list_of_live_dashboard_tabs App_tsx_TABS_ActivePanel cost_history_chart_renders_nowhere components_rendered_directly_in_App_tsx", type:project, ocd:2026-07-12, lmd:2026-09-08]
The dashboard has **no `Traces` tab, no `Flow` tab, and no `Cost` tab**. `App.tsx` `TABS` +
`ActivePanel` (media/src/App.tsx, `TABS` at ~L41) render only these 8: `sessions`, `context`,
`cache`, `history`, `analytics`, `patterns` (Advisor), `export`, `import` (plus `help`, a corner
button). `Traces()`, `Flow()`, AND `Cost()` top-level exports exist but are **dead** — esbuild
tree-shakes them (no `<Traces/>` / `<Flow/>` / `<Cost/>` render path). Consequence for Cost: the
30-day HistoryChart + lifetime tiles it wraps (fed by `dailyStats`/`lifetimeStats`) render
**nowhere**; the only LIVE cost pieces are `fmtUsd` / `CostBarChart` / `CostSection`, imported by
Sessions / Analytics / Help. Three components render **directly in App.tsx, not via `TABS`** — so
they are live despite not being tab entries: `<Alerts/>` (L117), `<Automation/>` (L120),
`<CollectorGapBanner/>` (L526).

^EB3WP35K [desc:"the session/subagent tree renders expand-in-place inside Sessions.tsx via TimelineWaterfall (trace) and FlowCanvas (flow), not via the dead Traces.tsx/Flow.tsx tabs", keywords:"where_does_session_tree_render where_is_subagent_tree_shown TimelineWaterfall_component SubAgentBranch_recursion FlowCanvas_canvas_view trace_flow_section_bar_Sessions_tsx SessionBlock_is_dead SessionDetail_sub_section_bar", type:project, ocd:2026-07-12, lmd:2026-09-08]
The session tree the user actually sees is **expand-in-place inside the Sessions tab**. `Sessions.tsx`
`SessionDetail` has a sub-section bar (`Overview | Trace | Flow | Tools | Files`, a `section` useState)
and renders, from Traces.tsx/Flow.tsx, only these reusable pieces:
- `section === 'trace'` → `<TimelineWaterfall …>` (Sessions.tsx ~L398) — this is where the timeline
  steps AND the **subagent tree** live (`SubAgentBranch`, Traces.tsx ~L1098, recurses back into
  `TimelineWaterfall`). `SessionBlock` (the Traces-TAB session wrapper) is NOT used here — it's dead.
- `section === 'flow'` → `<FlowCanvas sess=… height=…>` (Sessions.tsx ~L406) — the canvas flow view.
  (`FlowCanvas` is a `<canvas>`: its internal `SemNode` drops spanId/requestId, so per-node DOM
  buttons are impossible there; only a toolbar-level button fits.)

^07ZYE89X [desc:"to add a per-session/per-branch UI affordance, mount it in Sessions.tsx, SubAgentBranch, or the FlowCanvas toolbar — never in SessionBlock or the dead Traces()/Flow() top-level functions", keywords:"where_to_mount_a_new_ui_button add_per_session_ui_affordance mount_in_SubAgentBranch mount_in_FlowCanvas_toolbar do_not_mount_in_SessionBlock do_not_mount_in_Traces_Flow_top_level children_source_for_subagent_tree parentSessionId_filter", type:project, ocd:2026-07-12, lmd:2026-09-08]
So to add a per-session/per-branch UI affordance, mount it in **Sessions.tsx** (section bar, for the
whole session) and/or **`SubAgentBranch`** (subagent) and/or **`FlowCanvas` toolbar** — never in
`SessionBlock` or the `Traces()`/`Flow()` top-level functions.[^1] Children source for the subagent
tree: `sessionSummary.value.sessions` filtered by `parentSessionId === id && sessionId !== id`.

^9U881PBN [desc:"the live dashboard is the built media/dashboard.js bundle; a new server route needs the server process restarted, not just a browser reload, because a running server keeps the old bundle in memory", keywords:"rebuilt_dashboard_not_showing_new_endpoint server_needs_restart_after_new_route dashboard_js_bundle_stale browser_reload_not_enough_for_api_change deploy_live_ui agentlenspro_server_restart running_server_keeps_old_bundle", type:project, ocd:2026-07-12, lmd:2026-09-08]
Live UI = the built `media/dashboard.js` bundle, served static by the standalone server. A **running**
server keeps the OLD bundle in memory across a rebuild — a browser reload picks up a rebuilt
dashboard.js, but a NEW server route (e.g. an `/api/*` endpoint) needs the server **process restarted**
(`agentlenspro server restart` / `deploy:safe`). See [[agentlenspro-publish-pipeline]],
[[always-on-ingestion-model]].

## Notes and lessons learned
[^1]: [id:ATOM-FILENAME-NOT-RENDER-SURFACE, status:valid, keywords:"added_button_to_traces_tsx_but_invisible file_name_not_the_render_surface verify_actual_render_path_before_mounting dev_browser_check", ocd:2026-07-12, lmd:2026-07-12] TRDD-4CH9QLAH (copy-branch ⧉ tree button) first wired the button
  into `SessionBlock` (Traces tab) + `SubAgentBranch` + the Flow toolbar, then dev-browser found the
  SessionBlock mount was invisible because the Traces tab doesn't exist. Lesson: the file name
  (`Traces.tsx`/`Flow.tsx`) is NOT the render surface — verify the actual `ActivePanel`/`SessionDetail`
  render path before mounting UI, and prefer a live dev-browser check to confirm the element renders.
[^2]: [id:ATOM-RECALL-BEFORE-EDITING-DEAD-CODE, status:valid, keywords:"edited_dead_code inert_edit tree_shaken Cost_tab Flow_reroute file_inventory_vs_render_tree recall_before_editing", ocd:2026-07-17, lmd:2026-07-17] DO NOT trust a file-based
  inventory (a `.tsx` under `media/src/tabs/`) as the set of live surfaces — TRDD-06Q5AXYN (global
  time-window) edited dead code TWICE: Phase 2 rewrote `Cost()`'s aggregates and a Phase-1 reroute
  touched `Flow()`; BOTH landed **inert** (tree-shaken, changed nothing the user sees). BECAUSE the
  work started from a file list and I did NOT recall THIS page first, the same trap as [^1] was
  re-hit. DO map `App.tsx` `TABS`/`ActivePanel` (the live-render set) — and recall this page — BEFORE
  editing or mounting any tab component.
