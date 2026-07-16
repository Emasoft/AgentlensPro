// Review-sweep hardening — the shared browser-origin policy (src/httpOrigin.ts) used by BOTH the
// UI server and the MCP endpoint. The real-boot integration coverage lives in standaloneCors.test.ts;
// these are the fast table-driven unit cases for the predicate itself.
import * as assert from 'assert'
import type * as http from 'http'
import { isDisallowedCrossOrigin, setAllowedOriginCors } from '../httpOrigin'

function fakeReq(origin?: string, host?: string): http.IncomingMessage {
  return { headers: { ...(origin !== undefined ? { origin } : {}), ...(host !== undefined ? { host } : {}) } } as http.IncomingMessage
}

interface HeaderRec { name: string; value: string }
function fakeRes(): { res: http.ServerResponse; headers: HeaderRec[] } {
  const headers: HeaderRec[] = []
  const res = { setHeader: (name: string, value: string) => { headers.push({ name, value }) } } as unknown as http.ServerResponse
  return { res, headers }
}

suite('httpOrigin — isDisallowedCrossOrigin (the one origin policy for every local HTTP surface)', () => {
  test('no Origin header (CLI / same-origin GET) is allowed', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq(undefined, 'localhost:4700')), false)
  })

  test('a genuine same-origin request (Origin.host === Host) is allowed on any bind host', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('http://192.168.1.9:4700', '192.168.1.9:4700')), false)
  })

  test('loopback origins are allowed: localhost, 127.0.0.1, [::1], any port', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('http://localhost:1234', 'localhost:4700')), false)
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('http://127.0.0.1', 'localhost:4700')), false)
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('http://[::1]:3000', 'localhost:4700')), false)
  })

  test('a foreign web origin is refused', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('https://evil.com', 'localhost:4700')), true)
  })

  test('a lookalike subdomain (localhost.evil.com) is refused — hostname must BE loopback, not start with it', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('http://localhost.evil.com', 'localhost:4700')), true)
  })

  test('an unparseable Origin is refused (fail closed)', () => {
    assert.strictEqual(isDisallowedCrossOrigin(fakeReq('not a url', 'localhost:4700')), true)
  })
})

suite('httpOrigin — setAllowedOriginCors echoes allowed origins only, never the wildcard', () => {
  test('allowed loopback origin: echoed exactly, with Vary: Origin', () => {
    const { res, headers } = fakeRes()
    setAllowedOriginCors(fakeReq('http://localhost:9999', 'localhost:4700'), res)
    assert.deepStrictEqual(headers, [
      { name: 'Access-Control-Allow-Origin', value: 'http://localhost:9999' },
      { name: 'Vary', value: 'Origin' },
    ])
  })

  test('disallowed origin: NO ACAO header at all (the browser then blocks the read)', () => {
    const { res, headers } = fakeRes()
    setAllowedOriginCors(fakeReq('https://evil.com', 'localhost:4700'), res)
    assert.deepStrictEqual(headers, [])
  })

  test('no Origin header: nothing to echo, no headers set', () => {
    const { res, headers } = fakeRes()
    setAllowedOriginCors(fakeReq(undefined, 'localhost:4700'), res)
    assert.deepStrictEqual(headers, [])
  })
})
