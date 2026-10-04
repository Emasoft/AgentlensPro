// The CLI's default endpoints are derived from the SAME port vars the server binds. Asserted
// directly because the behavioural test one file over cannot see it: reverting `defaultUiUrl()`
// to a hardcoded :3000 left the whole suite green (TRDD-BSDR4TRM ai_review IMPORTANT-1), since a
// server happened to answer :4316 on the reviewer's machine.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dashboardUrl, envPort, mcpEndpoint, resetPortWarnings, uiBaseUrl } from '../cli/cliCore'
import { statsOwnership } from '../cli/serverControl'

const KEYS = ['UI_PORT', 'MCP_PORT', 'AGENTLENS_UI_URL', 'AGENTLENS_MCP_URL', 'AGENTLENS_DASHBOARD_URL'] as const

suite('cliCore — endpoint defaults follow the port env', () => {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  setup(() => { for (const k of KEYS) delete process.env[k] })
  suiteTeardown(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  test('UI_PORT / MCP_PORT choose the port; unset falls back to 3000 / 4316', () => {
    assert.strictEqual(uiBaseUrl(), 'http://localhost:3000')
    assert.strictEqual(mcpEndpoint(), 'http://localhost:4316/mcp')
    process.env.UI_PORT = '39001'
    process.env.MCP_PORT = '39002'
    assert.strictEqual(uiBaseUrl(), 'http://localhost:39001')
    assert.strictEqual(dashboardUrl(), 'http://localhost:39001')
    assert.strictEqual(mcpEndpoint(), 'http://localhost:39002/mcp')
  })

  test('an explicit AGENTLENS_*_URL still wins over the port env', () => {
    process.env.UI_PORT = '39001'
    process.env.MCP_PORT = '39002'
    process.env.AGENTLENS_UI_URL = 'http://example.invalid:1234'
    process.env.AGENTLENS_MCP_URL = 'http://example.invalid:5678/mcp'
    assert.strictEqual(uiBaseUrl(), 'http://example.invalid:1234')
    assert.strictEqual(mcpEndpoint(), 'http://example.invalid:5678/mcp')
  })

  test('junk in the port env falls back instead of throwing or injecting a path', () => {
    // Interpolating an unvalidated value would make `abc` an `Invalid URL` throw at every call
    // site and `8080/evil` a silent path injection into the endpoint.
    for (const bad of ['', '   ', 'abc', '0', '-1', '65536', '80.5', '8080/evil']) {
      process.env.UI_PORT = bad
      process.env.MCP_PORT = bad
      assert.strictEqual(uiBaseUrl(), 'http://localhost:3000', `UI_PORT=${JSON.stringify(bad)}`)
      assert.strictEqual(mcpEndpoint(), 'http://localhost:4316/mcp', `MCP_PORT=${JSON.stringify(bad)}`)
      assert.strictEqual(envPort(bad, 4318), '4318')
    }
  })
})

// TRDD-EGGERLEO: the expected column is the SAME table as the Rust test
// `mcp_port_from_env_rejects_zero_and_invalid_spellings` (server_stats.rs), plus the spellings the
// card ran. Rust's `u16` parse takes a leading `+`, so '+8080' must be accepted here too; the
// server rejects `3e3`/hex/binary, so the CLI must not resolve them to a different port.
suite('cliCore — envPort agrees with the server on which spellings are ports (TRDD-EGGERLEO)', () => {
  const FB = 4316
  const rows: Array<[string | undefined, number]> = [
    [undefined, FB], ['0', FB], ['', FB], ['   ', FB], ['abc', FB], ['-1', FB], ['65536', FB],
    ['80.5', FB], ['8080/evil', FB], ['3e3', FB], ['0x50', FB], ['0x1F80', FB], ['0b11', FB],
    ['8080', 8080], [' 8080 ', 8080], ['65535', 65535], ['+8080', 8080], ['08080', 8080],
  ]
  for (const [raw, want] of rows) {
    test(`envPort(${JSON.stringify(raw)}) -> ${want}`, () => {
      assert.strictEqual(envPort(raw, FB), String(want))
    })
  }

  test('a set-but-rejected port warns once on stderr and falls back; unset and valid warn nothing', () => {
    const saved = process.env.MCP_PORT
    const savedDir = process.env.DATA_DIR
    // Own data dir: a live collector's ports.json on this machine must not change the fallback.
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-envport-'))
    const realWrite = process.stderr.write
    const seen: string[] = []
    process.stderr.write = ((s: string | Uint8Array) => { seen.push(String(s)); return true }) as typeof process.stderr.write
    try {
      resetPortWarnings()
      process.env.MCP_PORT = '3e3'
      assert.strictEqual(mcpEndpoint(), 'http://localhost:4316/mcp')
      mcpEndpoint()
      assert.strictEqual(seen.length, 1, 'one warning per variable and value')
      assert.ok(seen[0].includes('MCP_PORT="3e3"') && seen[0].includes('using 4316'), seen[0])
      seen.length = 0
      process.env.MCP_PORT = '8080'
      mcpEndpoint()
      delete process.env.MCP_PORT
      mcpEndpoint()
      assert.deepStrictEqual(seen, [])
    } finally {
      process.stderr.write = realWrite
      fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true })
      if (savedDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDir
      if (saved === undefined) delete process.env.MCP_PORT; else process.env.MCP_PORT = saved
    }
  })
})

suite('serverControl — statsOwnership: whose data dir answered', () => {
  const mine = path.join(os.tmpdir(), 'agentlens-owner-mine')

  test('the same dir is ours, a different one is foreign', () => {
    assert.strictEqual(statsOwnership(mine, mine), 'ours')
    // Built by CONCATENATION, never path.join — path.join already normalizes, so a mutant that
    // drops both path.resolve() calls in statsOwnership and compares raw strings would still pass
    // a path.join-built input. Only path.resolve collapses a literal `/sub/../` segment, so this
    // fails the moment the resolve calls are removed.
    assert.strictEqual(statsOwnership(mine + '/sub/../', mine), 'ours')
    assert.strictEqual(statsOwnership(path.join(os.tmpdir(), 'agentlens-owner-theirs'), mine), 'foreign')
  })

  test('a server that reports NO data dir is unknown — never silently ours', () => {
    // The failure that matters: `unknown` collapsed into `ours` would print the confident status
    // line for a server we cannot prove owns this dir, which is the defect the verdict exists for.
    assert.strictEqual(statsOwnership(undefined, mine), 'unknown')
  })
})
