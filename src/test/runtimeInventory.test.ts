import * as assert from 'assert'
import { parsePsSnapshot, isClaudeRoot, buildClaudeInstances, buildRuntimeInventory } from '../runtimeInventory'

// ── get_runtime_inventory (TRDD-O981ZJKV item 13) — pure tree math on a snapshot ─────────────

const SNAPSHOT = [
  '    1     0   1000 10-00:00:00 /sbin/launchd',
  '  100     1 512000    02:10:00 /opt/homebrew/bin/claude',            // instance A (fat)
  '  110   100  80000       10:00 /bin/zsh -c pnpm run watch',          //  A child shell
  '  111   110 250000       09:00 node /repo/node_modules/esbuild',     //  A grandchild
  '  112   100  40960       01:00 claude',                              //  A NESTED claude (subagent CLI) — folds into A
  '  113   112  10240       00:30 /bin/bash /x/spy-agentlens.sh',       //  A great-grandchild via nested claude
  '  200     1 256000    01:00:00 /opt/homebrew/bin/claude',            // instance B
  '  300     1  90000    05:00:00 node /Users/x/.agentlens/server.js',  // unrelated (not under any claude)
  '  400     1   5000       00:10 grep claude /Users/x/.claude/notes',  // args mention claude — NOT a root
].join('\n')

suite('runtimeInventory — snapshot parsing + instance trees (TRDD-O981ZJKV)', () => {
  test('parsePsSnapshot reads pid/ppid/rss/etime/command; junk lines skipped', () => {
    const rows = parsePsSnapshot(SNAPSHOT + '\nnot a row\n')
    assert.strictEqual(rows.length, 9)
    assert.deepStrictEqual(rows[1], { pid: 100, ppid: 1, rssKb: 512000, etime: '02:10:00', command: '/opt/homebrew/bin/claude' })
  })

  test('isClaudeRoot matches argv0 basename only — never args that mention claude paths', () => {
    assert.strictEqual(isClaudeRoot('/opt/homebrew/bin/claude'), true)
    assert.strictEqual(isClaudeRoot('claude --resume abc'), true)
    assert.strictEqual(isClaudeRoot('grep claude /Users/x/.claude/notes'), false)
    assert.strictEqual(isClaudeRoot('node /Users/x/.claude/plugins/thing.js'), false)
  })

  test('instances: trees rolled up, nested claude folds into its parent, ranked by total RSS', () => {
    const instances = buildClaudeInstances(parsePsSnapshot(SNAPSHOT))
    assert.strictEqual(instances.length, 2, 'nested claude (pid 112) must NOT be its own instance')
    const [a, b] = instances
    assert.strictEqual(a.pid, 100, 'fattest tree first')
    assert.strictEqual(a.processCount, 5, 'root + shell + esbuild + nested claude + its hook child')
    // 512000 + 80000 + 250000 + 40960 + 10240 KB = 893200 KB ≈ 872.3 MB
    assert.ok(Math.abs(a.totalRssMb - 872.3) < 0.5, String(a.totalRssMb))
    assert.strictEqual(a.topProcesses[0].pid, 111, 'heaviest descendant ranked first')
    assert.strictEqual(b.pid, 200)
    assert.strictEqual(b.processCount, 1)
  })

  test('a ppid cycle in a torn snapshot cannot hang the ancestor walk', () => {
    const rows = parsePsSnapshot([
      '  500   501  1000 00:01 /bin/looper',
      '  501   500  1000 00:01 /bin/looper2',
      '  600     1  2000 00:05 claude',
    ].join('\n'))
    const instances = buildClaudeInstances(rows)
    assert.strictEqual(instances.length, 1)
  })

  test('buildRuntimeInventory over an injected snapshot: totals + note, no subprocess calls', () => {
    const r = buildRuntimeInventory({ psText: SNAPSHOT, noSubprocess: true }) as {
      instanceCount: number; totalRssMb: number; instances: Array<{ pid: number }>; claudeCodeVersion: null
    }
    assert.strictEqual(r.instanceCount, 2)
    assert.strictEqual(r.claudeCodeVersion, null)
    assert.ok(r.totalRssMb > 1000, String(r.totalRssMb))
  })
})
