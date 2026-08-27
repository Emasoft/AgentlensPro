// The CLI's default endpoints are derived from the SAME port vars the server binds. Asserted
// directly because the behavioural test one file over cannot see it: reverting `defaultUiUrl()`
// to a hardcoded :3000 left the whole suite green (TRDD-BSDR4TRM ai_review IMPORTANT-1), since a
// server happened to answer :4316 on the reviewer's machine.

import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { dashboardUrl, envPort, mcpEndpoint, uiBaseUrl } from '../cli/cliCore'
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

suite('serverControl — statsOwnership: whose data dir answered', () => {
  const mine = path.join(os.tmpdir(), 'agentlens-owner-mine')

  test('the same dir is ours, a different one is foreign', () => {
    assert.strictEqual(statsOwnership(mine, mine), 'ours')
    assert.strictEqual(statsOwnership(path.join(mine, '..', 'agentlens-owner-mine'), mine), 'ours')
    assert.strictEqual(statsOwnership(path.join(os.tmpdir(), 'agentlens-owner-theirs'), mine), 'foreign')
  })

  test('a server that reports NO data dir is unknown — never silently ours', () => {
    // The failure that matters: `unknown` collapsed into `ours` would print the confident status
    // line for a server we cannot prove owns this dir, which is the defect the verdict exists for.
    assert.strictEqual(statsOwnership(undefined, mine), 'unknown')
  })
})
