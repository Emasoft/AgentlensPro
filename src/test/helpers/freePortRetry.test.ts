// TRDD-1QFP73WA — falsification: spawnServerWithRetry must retry a bound port and succeed,
// rather than propagating `server exited early (code=1)` the way the unfixed per-file helpers
// did. Uses a tiny fake "server" script (not the real standalone/server.js) so the test is fast
// and exercises only the retry mechanism, not the real server's boot path.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import { freePort, spawnServerWithRetry } from './freePort'

// A minimal HTTP server: binds `process.env.FAKE_PORT`, answers 200 on /api/server-stats once
// listening, and — if the port is already taken — logs the exact "already in use" substring the
// retry logic keys on, then exits(1), mirroring the real server's refusal shape.
const FAKE_SERVER_SRC = `
const http = require('http')
const port = Number(process.env.FAKE_PORT)
const srv = http.createServer((req, res) => {
  if (req.url === '/api/server-stats') { res.writeHead(200); res.end('{}') }
  else { res.writeHead(404); res.end() }
})
srv.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[fake-server] Port ' + port + ' already in use')
    process.exit(1)
  }
  console.error(String(err))
  process.exit(1)
})
srv.listen(port, '127.0.0.1')
`

// A server that refuses to start for a reason that has NOTHING to do with ports, and says so
// before exiting 1 — modelled on serverSingleInstance.test.ts's real assertion that a second
// server on the same data dir MUST exit(1) with "Refusing to start". The retry helper must let
// this through on the FIRST attempt.
const FAKE_REFUSING_SRC = `
console.error('Refusing to start: another server already owns this data dir')
process.exit(1)
`

suite('spawnServerWithRetry — port-race falsification', () => {
  let tmpDir = ''
  let fakeServerJs = ''
  let fakeRefusingJs = ''

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-freeport-retry-'))
    fakeServerJs = path.join(tmpDir, 'fake-server.js')
    fs.writeFileSync(fakeServerJs, FAKE_SERVER_SRC)
    fakeRefusingJs = path.join(tmpDir, 'fake-refusing.js')
    fs.writeFileSync(fakeRefusingJs, FAKE_REFUSING_SRC)
  })

  suiteTeardown(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  test('a port already bound by something outside this process is retried with a fresh one, and the spawn succeeds', async function () {
    this.timeout(20_000)

    // Occupy a port ourselves — this simulates the OS having handed the "known free at probe
    // time" port to something else between our probe and the child's own listen().
    const occupiedPort = await freePort()
    const blocker = net.createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(occupiedPort, '127.0.0.1', () => resolve())
    })

    let buildEnvCalls = 0
    try {
      const { child, getLog } = await spawnServerWithRetry({
        serverJs: fakeServerJs,
        maxAttempts: 3,
        buildEnv: async () => {
          buildEnvCalls += 1
          // First attempt deliberately hands back the port we've already bound elsewhere —
          // stubbing exactly the allocator failure the spec calls for. Every retry gets a real
          // fresh port from freePort()'s claimed-set.
          const port = buildEnvCalls === 1 ? occupiedPort : await freePort()
          return { ...process.env, FAKE_PORT: String(port) } as NodeJS.ProcessEnv
        },
        readyPort: (env) => Number(env.FAKE_PORT),
      })

      try {
        assert.strictEqual(buildEnvCalls, 2, 'the helper must retry exactly once after the bound-port failure')
        assert.ok(/already in use/i.test(getLog()), 'the failed first attempt logged the port-race signature')
        assert.ok(child.pid, 'the retried spawn produced a live child')
        assert.strictEqual(child.exitCode, null, 'the retried child must still be running, not exited')
      } finally {
        child.kill('SIGKILL')
      }
    } finally {
      blocker.close()
    }
  })

  test('a failure that is NOT a port race fails on the FIRST attempt — the retry must not mask it', async function () {
    this.timeout(20_000)
    // The paired invariant, and the direction the retry can silently overshoot. The first cut of
    // isPortRaceFailure also matched a bare `exited early (code=1)`, which made EVERY exit(1)
    // retryable — so a genuine startup failure would burn three attempts and then be reported as
    // port contention, with the real reason buried. serverSingleInstance.test.ts asserts exactly
    // such a deliberate exit(1) ("Refusing to start"), so this is not hypothetical: it is one
    // `spawnServerWithRetry` call away. Both the server's own message and Node's raw EADDRINUSE
    // contain "already in use", so keying on that text loses no real port case.
    let buildEnvCalls = 0
    await assert.rejects(
      () => spawnServerWithRetry({
        serverJs: fakeRefusingJs,
        maxAttempts: 3,
        buildEnv: async () => {
          buildEnvCalls += 1
          return { ...process.env, FAKE_PORT: String(await freePort()) } as NodeJS.ProcessEnv
        },
        readyPort: (env) => Number(env.FAKE_PORT),
      }),
      (e: unknown) => {
        assert.match((e as Error).message, /exited early/i, 'the real failure must be what propagates')
        return true
      })
    assert.strictEqual(buildEnvCalls, 1,
      `a non-port failure must not be retried (buildEnv called ${buildEnvCalls}x) — retrying it wastes `
      + 'attempts and reframes a real startup bug as port contention')
  })
})
