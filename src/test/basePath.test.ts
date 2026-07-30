// Unit tests for the mount-prefix rules (AgentlensPro#4).
//
// The case that actually matters is the BOUNDARY one: with base `/lens`, the path `/lensing/x` is
// not under the mount. A naive `startsWith(base)` rewrites it to `ing/x` and 404s a legitimate
// route — a bug that only appears for whoever happens to have a route sharing a prefix with the
// mount, which is exactly the kind that ships.

import * as assert from 'assert'
import { normalizeBasePath, stripBasePath } from '../basePath'

suite('base path — normalizeBasePath', () => {
  test('off for empty, undefined, whitespace, and the root', () => {
    for (const v of [undefined, null, '', '   ', '/']) {
      assert.strictEqual(normalizeBasePath(v), '',
        `${JSON.stringify(v)} must normalise to OFF — treating "/" as a prefix doubles every slash`)
    }
  })

  test('adds a leading slash and strips trailing ones', () => {
    assert.strictEqual(normalizeBasePath('lens'), '/lens')
    assert.strictEqual(normalizeBasePath('/lens'), '/lens')
    assert.strictEqual(normalizeBasePath('/lens/'), '/lens')
    assert.strictEqual(normalizeBasePath('/lens///'), '/lens')
    assert.strictEqual(normalizeBasePath('  /lens/  '), '/lens')
  })

  test('keeps a multi-segment mount intact', () => {
    assert.strictEqual(normalizeBasePath('/tools/lens/'), '/tools/lens')
  })
})

suite('base path — stripBasePath', () => {
  test('no base configured is the identity function', () => {
    for (const p of ['/', '/api/x', '/dashboard.js']) {
      assert.strictEqual(stripBasePath(p, ''), p, 'a standalone install must be untouched')
    }
  })

  test('strips the mount from paths under it', () => {
    assert.strictEqual(stripBasePath('/lens/api/timeline/abc', '/lens'), '/api/timeline/abc')
    assert.strictEqual(stripBasePath('/lens/dashboard.js', '/lens'), '/dashboard.js')
  })

  test('the mount root itself becomes /', () => {
    assert.strictEqual(stripBasePath('/lens', '/lens'), '/',
      'GET on the mount root must serve the dashboard, not 404')
  })

  test('a path that merely SHARES A PREFIX with the mount is left alone', () => {
    // The whole reason the boundary check exists.
    assert.strictEqual(stripBasePath('/lensing/x', '/lens'), '/lensing/x')
    assert.strictEqual(stripBasePath('/lens-other', '/lens'), '/lens-other')
  })

  test('an unprefixed path is served as-is — the base path is not an access gate', () => {
    // Hooks and the CLI talk to this server directly and know nothing about a prefix an operator
    // set for a proxy. Refusing them here would break every local client on config change.
    assert.strictEqual(stripBasePath('/api/hook-config', '/lens'), '/api/hook-config')
    assert.strictEqual(stripBasePath('/', '/lens'), '/')
  })

  test('only the FIRST occurrence is removed', () => {
    assert.strictEqual(stripBasePath('/lens/lens/x', '/lens'), '/lens/x',
      'a nested path that repeats the mount name must keep its second segment')
  })

  test('a multi-segment mount strips whole', () => {
    assert.strictEqual(stripBasePath('/tools/lens/api/x', '/tools/lens'), '/api/x')
    assert.strictEqual(stripBasePath('/tools/lensx/api', '/tools/lens'), '/tools/lensx/api')
  })
})
