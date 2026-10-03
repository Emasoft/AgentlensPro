import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writePortsFile } from '../cli/portSelect'
import { resolveCtx } from '../cli/setup'

// setup must dial the ports the running server recorded (ports.json), exactly as `server start` and the
// CLI verbs do — owner rule 2026-10-02. Real files, no mocks.
suite('setup — port resolution follows ports.json', () => {
  const saved = { u: process.env.UI_PORT, m: process.env.MCP_PORT, o: process.env.OTLP_PORT }
  const restore = (): void => {
    for (const [k, v] of [['UI_PORT', saved.u], ['MCP_PORT', saved.m], ['OTLP_PORT', saved.o]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
  const ctxPorts = (dir: string): number[] => {
    const c = resolveCtx({ home: dir, dataDir: dir, repoRoot: process.cwd() })
    return [c.uiPort, c.mcpPort, c.otlpPort]
  }

  test('a live ports.json beats the defaults, a stale one does not, env beats both', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ports-'))
    try {
      delete process.env.UI_PORT; delete process.env.MCP_PORT; delete process.env.OTLP_PORT
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4999 })
      assert.deepStrictEqual(ctxPorts(dir), [3000, 4316, 4318], 'no pidfile: ports.json is stale and ignored')
      fs.writeFileSync(path.join(dir, 'server.pid'), String(process.pid))
      assert.deepStrictEqual(ctxPorts(dir), [3001, 4999, 4318])
      process.env.UI_PORT = '3555'
      assert.deepStrictEqual(ctxPorts(dir), [3555, 4999, 4318])
    } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
