import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { dataDir, dataPath, dataDirSource, resolveDataDir, DATA_DIR_ENV, DATA_DIR_ENV_GENERIC } from '../dataDir'

// The data directory is resolved in ONE place (TRDD-K7PQ2M4V). Nine modules used to hardcode
// ~/.agentlens, so a relocated store left every reader looking at an empty default and reporting
// "nothing found" — and the test suite, which isolates itself via the env var, did not isolate
// those modules at all: they read the developer's real store during a run.

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try { fn() } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}

suite('dataDir — the one resolution of the store location', () => {
  test('defaults to ~/.agentlens when neither variable is set', () => {
    withEnv({ [DATA_DIR_ENV]: undefined, [DATA_DIR_ENV_GENERIC]: undefined }, () => {
      assert.strictEqual(dataDir(), path.join(os.homedir(), '.agentlens'))
      assert.strictEqual(resolveDataDir().source, 'default')
    })
  })

  test('the namespaced variable wins over the generic one', () => {
    // DATA_DIR is a name Docker images, CI systems and data tooling all use for their own
    // purposes. A stray value must not silently relocate this tool's entire store when the
    // owner has said explicitly where it goes.
    withEnv({ [DATA_DIR_ENV]: '/mine/agentlens', [DATA_DIR_ENV_GENERIC]: '/someone/elses/data' }, () => {
      assert.strictEqual(dataDir(), '/mine/agentlens')
      assert.strictEqual(resolveDataDir().source, 'agentlens-env')
    })
  })

  test('the generic variable is still honoured — it is a shipped, documented contract', () => {
    // Dropping it would move a real user's store to the default and present as data loss.
    withEnv({ [DATA_DIR_ENV]: undefined, [DATA_DIR_ENV_GENERIC]: '/legacy/store' }, () => {
      assert.strictEqual(dataDir(), '/legacy/store')
      assert.strictEqual(resolveDataDir().source, 'generic-env')
    })
  })

  test('a blank or whitespace value is treated as unset, never as the empty path', () => {
    withEnv({ [DATA_DIR_ENV]: '   ', [DATA_DIR_ENV_GENERIC]: undefined }, () => {
      assert.strictEqual(dataDir(), path.join(os.homedir(), '.agentlens'))
    })
  })

  test('resolves per call, so a variable set after import is honoured', () => {
    // A module-level const would freeze the import-time value — wrong for a long-running server
    // and wrong for a test that sets the variable after the module graph loads.
    withEnv({ [DATA_DIR_ENV]: '/first' }, () => assert.strictEqual(dataDir(), '/first'))
    withEnv({ [DATA_DIR_ENV]: '/second' }, () => assert.strictEqual(dataDir(), '/second'))
  })

  test('dataPath joins under the resolved directory', () => {
    withEnv({ [DATA_DIR_ENV]: '/store' }, () => {
      assert.strictEqual(dataPath('otel-bodies'), path.join('/store', 'otel-bodies'))
      assert.strictEqual(dataPath('a', 'b.json'), path.join('/store', 'a', 'b.json'))
    })
  })

  test('dataDirSource flags the collision hazard only when the generic name is what won', () => {
    withEnv({ [DATA_DIR_ENV]: '/x', [DATA_DIR_ENV_GENERIC]: undefined }, () => {
      assert.ok(!/generic name/.test(dataDirSource()), dataDirSource())
    })
    withEnv({ [DATA_DIR_ENV]: undefined, [DATA_DIR_ENV_GENERIC]: '/y' }, () => {
      assert.match(dataDirSource(), /generic name/)
    })
  })
})
