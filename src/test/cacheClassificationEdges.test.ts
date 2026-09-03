import * as assert from 'assert'
import { cacheOrder, classifyTurn, firstDivergence, type RequestElement } from '../shared/cacheClassification'

// Regressions for the two defects found in the self-review of b96e82c2 (the advisor could not be
// consulted: Fable's weekly window was exhausted). Both are silent — they misplace the boundary
// without failing — so they need tests that pin the coordinates, not just the happy path.

const el = (path: RequestElement['path'], idx: number, key: string, o: Partial<RequestElement> = {}): RequestElement =>
  ({ path, idx, key, bytes: 100, breakpoint: false, ...o })

suite('cacheClassification — coordinate and clamping edges', () => {
  // DEFECT 1: the walk skips key-excluded elements independently on each side, so the index into the
  // current request and the index into the previous one drift apart when their counts differ. The
  // boundary is scanned over the PREVIOUS request, so it must be given the previous coordinate.
  test('divergence reports both coordinates when the key-excluded counts differ', () => {
    const prev = [
      el('system', 0, 'hdr-a', { keyExcluded: true }),
      el('system', 2, 'same'),
      el('system', 3, 'X'),
    ]
    const cur = [
      el('system', 0, 'hdr-b', { keyExcluded: true }),
      el('system', 1, 'hdr-extra', { keyExcluded: true }), // one MORE excluded element than prev
      el('system', 2, 'same'),
      el('system', 3, 'Y'), // the real divergence
    ]
    const d = firstDivergence(cacheOrder(prev), cacheOrder(cur))
    assert.strictEqual(d.index, 3, 'current-request coordinate')
    assert.strictEqual(d.prevIndex, 2, 'previous-request coordinate, one lower here')
    assert.notStrictEqual(d.index, d.prevIndex, 'the drift this test exists for')
  })

  // DEFECT 2a: a shorter current request must never receive a boundary naming a position it lacks.
  test('the boundary is clamped into the current request when content was removed', () => {
    const prev = [
      el('messages', 0, 'a', { breakpoint: true }),
      el('messages', 1, 'b', { breakpoint: true }),
      el('messages', 2, 'c', { breakpoint: true }),
    ]
    const cur = [el('messages', 0, 'a', { breakpoint: true })]
    const c = classifyTurn(prev, cur)
    assert.ok(c.boundary <= c.elements.length - 1, `boundary ${c.boundary} outside a ${c.elements.length}-element request`)
    assert.strictEqual(c.elements.length, 1)
    assert.ok(['cache-read', 'cache-write'].includes(c.elements[0].cls))
  })

  // DEFECT 2b: when the previous request's trailing marker sits past this request's own last marker,
  // surviving elements were classified as uncached fresh input.
  test('an element that survived is never reported as fresh input', () => {
    const prev = [
      el('system', 0, 's0'),
      el('system', 3, 's3', { breakpoint: true }),
      el('messages', 0, 'm0', { breakpoint: true }),
      el('messages', 1, 'm1', { breakpoint: true }),
    ]
    // Same content, but this request carries no trailing marker at all.
    const cur = [
      el('system', 0, 's0'),
      el('system', 3, 's3', { breakpoint: true }),
      el('messages', 0, 'm0'),
      el('messages', 1, 'm1'),
    ]
    const c = classifyTurn(prev, cur)
    for (const e of c.elements) {
      if (e.position <= c.boundary) {
        assert.strictEqual(e.cls, 'cache-read', `${e.path}[${e.idx}] survived but was classed ${e.cls}`)
      }
    }
    assert.ok(c.lastBreakpointIndex >= c.boundary, 'the cacheable end can never precede what survived')
  })

  test('a first request with no predecessor classifies nothing as cache-read', () => {
    const c = classifyTurn(null, [el('tools', 0, 't0'), el('messages', 0, 'm0', { breakpoint: true })])
    assert.strictEqual(c.boundary, -1)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-read').length, 0)
  })

  test('two identical requests diverge nowhere and keep every element cached', () => {
    const els = [el('tools', 0, 't0'), el('system', 3, 's3', { breakpoint: true }), el('messages', 0, 'm0', { breakpoint: true })]
    const c = classifyTurn(els, els)
    assert.ok(c.divergence.appendOnly)
    assert.strictEqual(c.divergence.index, -1)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-read').length, els.length)
  })
})
