import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execRegisteredCommand, resolveCtx } from '../cli/setup'

// TRDD-4EV3OJ19 — the env handed to a registered hook command must carry the ports setup
// converged to, because a failed hook POST revives alcore with ports read from that env.
// Real: the command is a real /bin/sh child that writes its own environment to a temp file.
suite('setup — registered command env pins the converged ports', () => {
  let home: string
  suiteSetup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-revive-ports-')) })
  suiteTeardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('execRegisteredCommand passes UI_PORT, MCP_PORT and OTLP_PORT from the ctx, not the ambient env', () => {
    const out = path.join(home, 'env.txt')
    const ctx = resolveCtx({
      home, dataDir: path.join(home, '.agentlens'), repoRoot: home, uiPort: 41001, mcpPort: 41002, otlpPort: 41003,
      pathEnv: process.env.PATH ?? '', log: () => { /* quiet */ },
    })
    const saved = { u: process.env.UI_PORT, m: process.env.MCP_PORT, o: process.env.OTLP_PORT }
    process.env.UI_PORT = '1'; process.env.MCP_PORT = '2'; process.env.OTLP_PORT = '3' // ambient values that must lose
    try {
      assert.strictEqual(execRegisteredCommand(ctx, `env > '${out}'`, '', true), null)
    } finally {
      for (const [k, v] of [['UI_PORT', saved.u], ['MCP_PORT', saved.m], ['OTLP_PORT', saved.o]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
    const lines = fs.readFileSync(out, 'utf8').split('\n')
    assert.ok(lines.includes('UI_PORT=41001'), 'UI_PORT pinned')
    assert.ok(lines.includes('MCP_PORT=41002'), 'MCP_PORT pinned')
    assert.ok(lines.includes('OTLP_PORT=41003'), 'OTLP_PORT pinned')
  })
})
