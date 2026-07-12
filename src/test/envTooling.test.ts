import * as assert from 'assert'
import { runtimesFromEnv, TOOL_CATALOG } from '../environment/tooling'

suite('environment/tooling (TRDD-HUWJVQJA — dev-tooling detector)', () => {
  test('runtimesFromEnv reads VIRTUAL_ENV + CONDA_DEFAULT_ENV from the given env, nvmDir stays null', () => {
    const result = runtimesFromEnv({ VIRTUAL_ENV: '/x/.venv', CONDA_DEFAULT_ENV: 'base' })
    assert.strictEqual(result.venv, '/x/.venv')
    assert.strictEqual(result.conda, 'base')
    assert.strictEqual(result.nvmDir, null)
  })

  test('runtimesFromEnv returns all null on an empty env', () => {
    const result = runtimesFromEnv({})
    assert.strictEqual(result.venv, null)
    assert.strictEqual(result.conda, null)
    assert.strictEqual(result.nvmDir, null)
  })

  test('runtimesFromEnv picks up NVM_DIR independently of venv/conda', () => {
    const result = runtimesFromEnv({ NVM_DIR: '/home/x/.nvm' })
    assert.strictEqual(result.nvmDir, '/home/x/.nvm')
    assert.strictEqual(result.venv, null)
    assert.strictEqual(result.conda, null)
  })

  test('TOOL_CATALOG has a non-empty entry list for every category', () => {
    const categories = Object.keys(TOOL_CATALOG)
    assert.ok(categories.length > 0, 'catalog is not empty')
    for (const category of categories) {
      assert.ok(TOOL_CATALOG[category].length > 0, `${category} has entries`)
    }
  })

  test('every catalog entry across every category has a non-empty bin name', () => {
    for (const category of Object.keys(TOOL_CATALOG)) {
      for (const entry of TOOL_CATALOG[category]) {
        assert.ok(typeof entry.bin === 'string' && entry.bin.length > 0, `${category} entry has a bin`)
      }
    }
  })

  test('node is present under the runtimes category', () => {
    const bins = TOOL_CATALOG.runtimes.map((e) => e.bin)
    assert.ok(bins.includes('node'), 'node is a tracked runtime')
  })
})
