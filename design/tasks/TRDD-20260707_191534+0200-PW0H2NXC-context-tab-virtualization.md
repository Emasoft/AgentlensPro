---
trdd-id: PW0H2NXC
title: Context tab DOM virtualization — stop rendering 150k+ elements at once
column: planned
created: 2026-07-07T19:15:34+0200
updated: 2026-07-07T19:15:34+0200
current-owner: null
assignee: null
priority: 3
severity: MEDIUM
effort: M
task-type: bugfix
parent-trdd: TRDD-TKN5VALS
approval-tier: 0
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: []
external-refs: []
---

# TRDD-PW0H2NXC — Context tab DOM virtualization

## ⏵ STATE — filed 2026-07-07 from headless UI test evidence; not yet dispatched

## Why (measured live, 2026-07-07, dev-browser headless)
Opening the Context tab on a real dataset put **141,361–156,110 elements** in the DOM
(~2.1 MB innerText) in one shot. Interaction scripting times out on it; screenshots hang;
scrolling/theming on a DOM that size is degraded for every user. The server side of this
pathology (endpoint OOM) was fixed by TRDD-PJC8N1HO spec 5 — this TRDD is the remaining
CLIENT side. Other tabs render 3.8k–16.8k elements and behave fine.

## Spec
1. Virtualize the Context tab's block list (`media/src/tabs/ContextTab.tsx`): render only
   the viewport window (+overscan); collapsed-by-default deep branches; expand-on-demand
   fetch for block bodies rather than mounting all content upfront.
2. Respect the no-nested-scrollbars rule: virtualization must use the page's own scroll
   (window scroller), not an inner overflow box.
3. Keep totals/summary derived from data, not from mounted DOM.

## Acceptance
- Context tab on the same dataset mounts <10k DOM elements at rest; expanding any block
  shows its full content on demand (no data loss vs today).
- dev-browser probe (click tab, measure `document.querySelectorAll('*').length`, screenshot)
  completes within the 30s script budget.
- check-types + lint + esbuild + unit suite clean; no regression in Context data shown.
