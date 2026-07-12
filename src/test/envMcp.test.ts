import * as assert from 'assert'
import { parseMcpServers, type McpServerInfo } from '../environment/mcp'

suite('environment/mcp — parseMcpServers (TRDD-HUWJVQJA)', () => {
  test('extracts stdio/http/http types from mixed server entries', () => {
    const json = {
      mcpServers: {
        fs: { command: 'npx', args: [] },
        api: { url: 'https://x/mcp', type: 'http' },
        sse1: { url: 'http://y/sse' },
      },
    }
    const servers = parseMcpServers(json, 'user')
    assert.strictEqual(servers.length, 3)
    const byName = (n: string): McpServerInfo | undefined => servers.find((s) => s.name === n)
    assert.strictEqual(byName('fs')?.type, 'stdio', 'command entry infers stdio')
    assert.strictEqual(byName('api')?.type, 'http', 'explicit type wins')
    assert.strictEqual(byName('sse1')?.type, 'http', 'url starting with http infers http, not sse')
    assert.ok(servers.every((s) => s.scope === 'user'), 'scope propagated to every entry')
  })

  test('empty object with no mcpServers map returns an empty array', () => {
    assert.deepStrictEqual(parseMcpServers({}, 'user'), [])
  })

  test('null input returns an empty array', () => {
    assert.deepStrictEqual(parseMcpServers(null, 'user'), [])
  })

  test('non-object (string) input returns an empty array', () => {
    assert.deepStrictEqual(parseMcpServers('string', 'user'), [])
  })

  test('entry with neither command, url, nor type is classified unknown', () => {
    const servers = parseMcpServers({ mcpServers: { mystery: {} } }, 'project')
    assert.strictEqual(servers.length, 1)
    assert.strictEqual(servers[0].type, 'unknown')
    assert.strictEqual(servers[0].scope, 'project')
  })

  test('mcpServers that is not itself an object yields no entries', () => {
    assert.deepStrictEqual(parseMcpServers({ mcpServers: 'not-a-map' }, 'user'), [])
  })
})
