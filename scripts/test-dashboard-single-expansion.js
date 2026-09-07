#!/usr/bin/env node
// Runnable check for TRDD-BLAV6W15 (dashboard single-expansion auto-collapse).
//
// media/src has no DOM-rendering test harness (no jsdom/testing-library), so instead of
// mounting components this bundles media/src/state.ts — the single source of truth that
// `SessionBlock`/`SubAgentBranch` derive their `collapsed`/`open` JSX-conditional rendering
// from — and asserts the state contract directly:
//   1. expandedTraceId holds exactly ONE id at a time (expanding one collapses every other,
//      by construction: there is nowhere else for a second "open" node to live).
//   2. setExpandedTraceId() evicts every OTHER session's cached timeline/fileOps/generatedFiles
//      when switching, which is what makes the JSX `{!collapsed && (...)}` unmount actually
//      release the data (Preact removing a node from the tree does nothing for a signal
//      still holding that node's payload — this is the release that matters).
//   3. re-expanding a previously-collapsed session finds its data gone (fetched on expand,
//      dropped on collapse — not fetched once and retained for the session).
const esbuild = require('esbuild')
const path = require('path')
const Module = require('module')

const STATE_TS = path.join(__dirname, '..', 'media', 'src', 'state.ts')

function loadState() {
  const result = esbuild.buildSync({
    entryPoints: [STATE_TS],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['@preact/signals'],
  })
  const code = result.outputFiles[0].text
  // state.ts reads `window.__INITIAL_*__` unconditionally at module scope — stub it so the
  // bundle evaluates outside a browser, same as any other headless test of browser code.
  global.window = { __INITIAL_SESSION_SUMMARY__: null, __INITIAL_TOOL_CALLS__: {} }
  const m = new Module(STATE_TS, module)
  m.filename = STATE_TS
  m.paths = Module._nodeModulePaths(path.dirname(STATE_TS))
  m._compile(code, STATE_TS)
  return m.exports
}

const state = loadState()
const { expandedTraceId, setExpandedTraceId, cacheSessionDetail, sessionTimelines, sessionFileOps, sessionGeneratedFiles } = state

let failures = 0
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); failures++ }
  else console.log(`PASS: ${label}`)
}

// Seed two sessions' cached detail, as if both had been expanded and fetched at some point.
cacheSessionDetail('sess-a', [{ spanId: 'a1' }], [{ path: 'a.ts', bytesRead: 1, bytesWritten: 0 }])
setExpandedTraceId('sess-a')
cacheSessionDetail('sess-b', [{ spanId: 'b1' }], [{ path: 'b.ts', bytesRead: 1, bytesWritten: 0 }])

// 1. Expanding sess-b must collapse sess-a — one id, not a set.
setExpandedTraceId('sess-b')
check('expanding one node leaves exactly one id expanded', expandedTraceId.value === 'sess-b')
check('the previously-expanded node is no longer the expanded one', expandedTraceId.value !== 'sess-a')

// 2. sess-a's cached payload must be released (unmounting the JSX subtree only removes the
//    DOM nodes; releasing the signal-held payload is what stops it being "resident").
check('collapsed node timeline data is released', sessionTimelines.value['sess-a'] === undefined)
check('collapsed node file-op data is released', sessionFileOps.value['sess-a'] === undefined)
check('the newly-expanded node keeps its own cached data', sessionTimelines.value['sess-b']?.[0]?.spanId === 'b1')

// 3. Re-expanding sess-a finds nothing cached — it was dropped on collapse, not retained.
setExpandedTraceId('sess-a')
check('re-expanding a collapsed node starts with no stale cached data', sessionTimelines.value['sess-a'] === undefined)

// Collapsing everything (no node expanded) must release the last node's data too.
setExpandedTraceId(null)
check('collapsing to no expansion releases all cached data', Object.keys(sessionTimelines.value).length === 0)
check('expandedTraceId is null when nothing is expanded', expandedTraceId.value === null)
void sessionGeneratedFiles

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
