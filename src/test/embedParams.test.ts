// TRDD-FMIZO8Y4 — the embed/deep-link parser IS the ai-maestro iframe contract's client half:
// these tests pin that an unknown tab can never leak into the UI state and that the embed flag
// accepts exactly the documented truthy forms.
import * as assert from 'assert'
import { parseEmbedParams } from '../shared/embedParams'

const TABS = ['sessions', 'context', 'cache', 'history'] as const

suite('parseEmbedParams — the dashboard embed/deep-link contract (TRDD-FMIZO8Y4)', () => {
  test('a valid tab id passes through', () => {
    assert.deepStrictEqual(parseEmbedParams('?tab=cache', TABS), { embed: false, tab: 'cache' })
  })

  test('an unknown tab is DROPPED, never forwarded (normalizeTabId is a passthrough downstream)', () => {
    assert.deepStrictEqual(parseEmbedParams('?tab=evil', TABS), { embed: false })
  })

  test('embed accepts the documented truthy forms (1/true/yes), case-insensitive', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', 'Yes']) {
      assert.strictEqual(parseEmbedParams(`?embed=${v}`, TABS).embed, true, `embed=${v}`)
    }
  })

  test('other embed values (0/false/empty) do NOT enable embed mode', () => {
    for (const v of ['0', 'false', 'no', '']) {
      assert.strictEqual(parseEmbedParams(`?embed=${v}`, TABS).embed, false, `embed=${v}`)
    }
  })

  test('both params combine; unknown params are ignored', () => {
    assert.deepStrictEqual(
      parseEmbedParams('?embed=1&tab=history&junk=x', TABS),
      { embed: true, tab: 'history' })
  })

  test('an empty/absent search string yields the defaults, with and without the leading ?', () => {
    assert.deepStrictEqual(parseEmbedParams('', TABS), { embed: false })
    assert.deepStrictEqual(parseEmbedParams('tab=context', TABS), { embed: false, tab: 'context' })
  })
})
