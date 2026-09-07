---
trdd-id: BLAV6W15
title: Only one node may be expanded in the dashboard at a time — expanding one collapses the rest
column: dev
created: 2026-09-07T19:36:46+0200
updated: 2026-09-07T19:36:46+0200
current-owner: main
task-type: feature
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [dashboard, preact, memory, media]
---

# Only one node may be expanded in the dashboard at a time

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07

**IN FLIGHT, uncarded until now.** A background lean-worker was dispatched at ~19:20 to implement
single-expansion auto-collapse in `media/src/`. The card is being written after the dispatch;
that gap is the defect this file corrects.

**The worker holds `media/src/Traces.tsx`.** Do not edit it. Two diagnostics surfaced from that
file mid-refactor (`Cannot find name 'setOpen'` at 1329, then an unused `totalCount` at 1681, the
line having moved 1679 → 1681 between snapshots); both were forwarded to the worker. As of 19:41
`pnpm run check-types` exits 0, so the hard error is resolved.

**Note for anyone rebuilding while this is open:** a bare `node esbuild.js` rebuilds the dashboard
bundle too, from whatever state `Traces.tsx` happens to be in. esbuild does not type-check — it
strips types and emits — so an unresolved identifier compiles to a runtime `ReferenceError`
rather than a build failure. Check `pnpm run check-types` before rebuilding while this card is in
`dev`.

## WHY

OWNER DIRECTIVE, verbatim (2026-09-07): *"even the web app must implement a auto-collapse system,
where only one leaf/branch/trace/session can be expanded at any time. expanding one branch, must
collapse all the others. so only one page of heavy data will be shown in the browser, and
typescript will only need to handle small ephemeral chunks of data coming from the duckdb
query."*

This is the browser half of the same ruling that TRDD-WKLD508O and TRDD-KBM09XHB implement on the
server: nothing heavy is resident, one page of data at a time, discarded after use.

## The requirement that makes it real

**Collapsing must UNMOUNT, not hide.** `display: none` leaves the component mounted, its state
alive and its data retained — the browser still holds every expanded node's payload, which is
exactly the residency the directive forbids. The collapsed branch must be removed from the tree
so its data becomes garbage.

Single-expansion means one expanded node across the whole view, not one per level: expanding any
leaf, branch, trace or session collapses every other expanded node.

## Acceptance

1. Expanding any node collapses all others — asserted by a test, not by inspection.
2. A collapsed node's subtree is unmounted; its data is not reachable from the component tree. A
   test asserts the child component's unmount, or that the fetched payload is released.
3. Expanded-node data is fetched on expand and dropped on collapse, rather than fetched once and
   retained for the session.
4. `pnpm run check-types` and `pnpm run lint` pass. `noUnusedLocals` is on, so a leftover prop or
   variable from the refactor is build-breaking.

## Derived risks

- Removing a prop threaded through several components strands its callers. `totalCount` already
  surfaced this way. Grep for every reference — direct calls, type-level references, tests — per
  the project's no-semantic-search rule.
- A re-fetch on every expand replaces a memory cost with a latency cost. Measure it; do not
  discover it. If a node is expanded and collapsed repeatedly the fetch count grows linearly —
  acceptable under this directive, but worth recording.
- `media/src` must not re-declare anything `src/shared/` exports; `pnpm run check-mirrors` fails
  the build if it does.
