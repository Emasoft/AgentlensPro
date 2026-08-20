// Regenerates runtimeinv-expected.json from the COMPILED src/runtimeInventory.ts — the parity
// oracle for get_runtime_inventory (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-runtimeinv-expected.mjs
//
// Both engines are driven over a FIXTURE ps snapshot (the TS test seam `psText`, mirrored by the
// Rust `ps_text` parameter) with subprocesses disabled, so no test ever reads a live process table
// or spawns lsof — and the fixture can contain shapes a real machine rarely produces.
//
// Discriminators the snapshot is built to exercise:
//  - argv0 BASENAME matching. `/usr/bin/claude` is a root; `node /x/.claude/foo.js` is NOT, even
//    though its args mention .claude — matching the whole command line false-positives on those.
//  - a NESTED claude folds into its parent instance instead of being counted as a second one.
//  - ps pads columns with RUNS of spaces, and commands contain spaces — the row regex must keep
//    the command verbatim.
//  - a ppid CYCLE (a torn snapshot) must terminate, not hang.
//  - a process whose ppid names a pid NOT in the snapshot is its own island, not a claude child.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { parsePsSnapshot, isClaudeRoot, buildClaudeInstances, buildRuntimeInventory } = require('../../../../../out/test/runtimeInventory.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = 1_760_000_000_000

// Deliberately ragged: aligned columns, a header line, a blank line, and a torn line.
const PS = [
  '  PID  PPID   RSS ELAPSED COMMAND',
  '  100     1  250000  02:15:33 /usr/local/bin/claude',
  '  101   100   40000     15:02 /bin/zsh -c source /Users/x/.claude/shell-snapshots/snap.sh && eval git status',
  '  102   101   90000     14:58 node /Users/x/.claude/plugins/mcp/server.js --port 1234',
  '  103   100  120000     09:41 /usr/local/bin/claude --agent worker',
  '  104   103   30000     09:40 /bin/sh -c echo nested-child-of-nested-claude',
  '  200     1  180000  00:44:10 claude',
  '  201   200   10000     00:31 /usr/bin/rg --json pattern',
  '  300     1   70000     05:00 node /Users/x/.claude/hooks/watcher.js',
  '  400   999   50000     01:00 /bin/bash -c orphan-with-unknown-parent',
  '  500   501   11000     02:00 /bin/sh cycle-a',
  '  501   500   12000     02:00 /bin/sh cycle-b',
  'torn-line-without-numbers',
  '',
].join('\n')

const rootCases = [
  '/usr/local/bin/claude',
  'claude',
  '  claude --resume  ',
  'node /Users/x/.claude/plugins/mcp/server.js',
  '/usr/local/bin/claude-code',
  'claudex',
  '/opt/claude/bin/claude --agent worker',
  '',
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
// `checkedAtIso` comes from `new Date().toISOString()`, which reads the system clock DIRECTLY —
// stubbing `Date.now` alone leaves it floating and the oracle drifts on every regeneration. The
// whole constructor is replaced so the no-arg form is pinned too.
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length === 0 ? [NOW] : a)) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate
try {
  writeFileSync(join(dir, 'runtimeinv-expected.json'), JSON.stringify({
    nowMs: NOW,
    psText: PS,
    rows: J(parsePsSnapshot(PS)),
    rootCases: J(rootCases),
    rootResults: rootCases.map(c => isClaudeRoot(c)),
    instances: J(buildClaudeInstances(parsePsSnapshot(PS))),
    report: J(buildRuntimeInventory({ psText: PS, noSubprocess: true })),
    emptyReport: J(buildRuntimeInventory({ psText: '', noSubprocess: true })),
  }, null, 1) + '\n')
} finally {
  globalThis.Date = RealDate
}
console.log(`runtimeinv-expected.json: ${parsePsSnapshot(PS).length} row(s), ${rootCases.length} root case(s)`)
