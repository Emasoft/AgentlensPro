// TRDD-RBBEX59R c2 item 2: the ts-repair precondition once the kill-switch stops counting as a revive brake. Under the
// switch a hook revive now STARTS a (no-collection) server, so only the NO_REVIVE brake guarantees no server comes up
// during the store rewrite (src/cli/storeAdmin.ts). Split out of noCollectionEnable.test.ts in round 2: not about enable.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { armKillSwitch, noRevivePath } from '../cli/killSwitch'
import { runStoreCli } from '../cli/storeAdmin'
import { effectiveBodiesDir } from '../captureConfig'
import { freePort } from './helpers/freePort'
suite('ts-repair under the kill-switch requires NO_REVIVE (TRDD-RBBEX59R c2 item 2)', () => {
  const saved = { d: process.env.AGENTLENS_DATA_DIR, u: process.env.AGENTLENS_UI_URL, e: process.env.AGENTLENS_DISABLED }
  let dir = ''
  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-tsrepair-'))
    process.env.AGENTLENS_DATA_DIR = dir
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${await freePort()}` // nothing listens: the server-up gate passes
    delete process.env.AGENTLENS_DISABLED
    fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'store', '.pass-state.json'), JSON.stringify({ strandedNames: ['parked.json'] }))
    fs.mkdirSync(effectiveBodiesDir(dir), { recursive: true })
    fs.writeFileSync(path.join(effectiveBodiesDir(dir), 'parked.json'), '{}')
  })
  teardown(() => {
    for (const [k, v] of [['AGENTLENS_DATA_DIR', saved.d], ['AGENTLENS_UI_URL', saved.u], ['AGENTLENS_DISABLED', saved.e]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const run = async (): Promise<{ ret: number; err: string }> => {
    const error = console.error, log = console.log
    let err = ''
    console.error = (...a: unknown[]) => { err += a.join(' ') + '\n' }
    console.log = () => { /* quiet */ }
    // The process-table scan is the real machine's (a live collector would refuse first) and alstore would run a real
    // repair: both are injected, so the run stops at the revive-brake gate or at the gate right after it.
    try { return { ret: await runStoreCli(['repair-parked'], { writers: () => [], alstore: () => null }), err } } finally { console.error = error; console.log = log }
  }

  test('the switch alone no longer satisfies the brake precondition; NO_REVIVE does', async () => {
    armKillSwitch(undefined, dir)
    const braked = await run()
    assert.strictEqual(braked.ret, 1)
    assert.match(braked.err, /REFUSED: the hook revive is not braked/, 'DISABLED without NO_REVIVE is refused')
    fs.writeFileSync(noRevivePath(dir), 'test')
    const passed = await run()
    assert.strictEqual(passed.ret, 1)
    assert.doesNotMatch(passed.err, /not braked/, 'NO_REVIVE passes the brake gate')
    assert.match(passed.err, /no alstore binary/, 'and the run stops at the NEXT gate, proving it got past the brake')
  })
})
