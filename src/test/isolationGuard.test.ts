import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── isolation guard: setup.js's leaked-live-server protection (TRDD-5IDBAJ6O) ──
// Kept in its own file so the suite can be rewritten whole with `fastedit create --force`
// (fastedit cannot address lines inside a suite() callback -- TRDD-H0ZDM156).
//
// setup.js snapshots every already-running alcore server's DATA_DIR at require time
// (findLiveServerDataDirs(), not exported) and assertContained() throws when a test's own
// DATA_DIR/HOME falls inside one of those live dirs, so a careless test can never point at
// -- and corrupt -- a real running server's data. This suite proves that guard fires, and that
// it does NOT fire for an unrelated sibling directory.

suite('isolation guard: a pre-existing live server data dir', () => {
  // Loads the SAME setup.js module instance mocharc already required at process start (require
  // caches by resolved absolute path, so this resolves to the identical cached instance) -- this
  // exercises the REAL assertContained / live-dir list, not a re-implementation of its logic.
  const isolationSetup = require(path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'setup.js'))

  test('assertContained throws for a path under an already-running alcore server data dir, and passes for a sibling mkdtemp', () => {
    const liveDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-live-guard-test-')))
    const siblingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-live-guard-sibling-')))
    const saved = isolationSetup._getLiveServerDataDirsForTest()
    isolationSetup._setLiveServerDataDirsForTest([liveDir])
    try {
      assert.throws(
        () => isolationSetup.assertContained('DATA_DIR', path.join(liveDir, 'sub')),
        /already-running alcore server/,
      )
      assert.doesNotThrow(() => isolationSetup.assertContained('DATA_DIR', path.join(siblingDir, 'sub')))
    } finally {
      // Restore the EXACT load-time snapshot (via the real getter, not []) -- a snapshot
      // recomputed at test time could include a server another suite started in the meantime
      // and make later tests trip the guard on a dir that was never live when THIS run began.
      isolationSetup._setLiveServerDataDirsForTest(saved)
      fs.rmSync(liveDir, { recursive: true, force: true })
      fs.rmSync(siblingDir, { recursive: true, force: true })
    }
    assert.deepStrictEqual(isolationSetup._getLiveServerDataDirsForTest(), saved)
  })
})
