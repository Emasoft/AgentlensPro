import * as assert from 'assert'
import {
  cacheOrder, classifyTurn, firstDivergence, isKeyExcludedText, lastBreakpoint, reconcile,
  survivingBoundary, type RequestElement,
} from '../shared/cacheClassification'

// The layout below mirrors a REAL measured request (session 25cbe9f1, 2026-09-03): 84 tools, a
// system[0] billing header that changes every turn and is not key material, breakpoints on
// system[3] and system[4], messages appended each turn with a breakpoint on the last one.
const TOOLS = 84
function build(opts: { messages: number; toolSalt?: string; sysSalt?: string; headerSalt?: string; msgSalt?: Record<number, string> } ): RequestElement[] {
  const els: RequestElement[] = []
  for (let i = 0; i < TOOLS; i++) {
    els.push({ path: 'tools', idx: i, key: `tool-${i}-${opts.toolSalt ?? 'v1'}`, bytes: 1000, breakpoint: false })
  }
  // system[0] is the billing header: different content every turn, excluded from the cache key.
  els.push({ path: 'system', idx: 0, key: `hdr-${opts.headerSalt ?? 'a'}`, bytes: 174, breakpoint: false, keyExcluded: true })
  els.push({ path: 'system', idx: 2, key: `sys2-${opts.sysSalt ?? 'v1'}`, bytes: 934, breakpoint: false })
  els.push({ path: 'system', idx: 3, key: `sys3-${opts.sysSalt ?? 'v1'}`, bytes: 1310, breakpoint: true })
  els.push({ path: 'system', idx: 4, key: `sys4-${opts.sysSalt ?? 'v1'}`, bytes: 15762, breakpoint: true })
  for (let i = 0; i < opts.messages; i++) {
    els.push({
      path: 'messages', idx: i, key: `msg-${i}-${opts.msgSalt?.[i] ?? 'v1'}`, bytes: 500,
      breakpoint: i === opts.messages - 1,
    })
  }
  return els
}
const posOf = (els: RequestElement[], path: string, idx: number) =>
  cacheOrder(els).findIndex(e => e.path === path && e.idx === idx)

suite('cacheClassification', () => {
  test('orders elements tools -> system -> messages, not by the order given', () => {
    const els = build({ messages: 3 })
    const shuffled = [...els].reverse()
    const ordered = cacheOrder(shuffled)
    assert.strictEqual(ordered[0].path, 'tools')
    assert.strictEqual(ordered[0].idx, 0)
    assert.strictEqual(ordered[TOOLS].path, 'system')
    assert.strictEqual(ordered[ordered.length - 1].path, 'messages')
  })

  test('recognises the billing header as key-excluded', () => {
    assert.ok(isKeyExcludedText('x-anthropic-billing-header: cc_version=2.1.259; cc_prev_req=req_x'))
    assert.ok(isKeyExcludedText('  X-Anthropic-Billing-Header: cc_entrypoint=cli'))
    assert.ok(!isKeyExcludedText('You are Claude Code, Anthropic official CLI'))
  })

  // THE regression this module exists for. Measured 738/738 pairs: the header changed every turn
  // and cache_read was never 0. If the header counted as key material the divergence would land at
  // cache-order index 84 every turn and the whole prefix would read as re-written.
  test('a changed billing header alone is NOT a divergence', () => {
    const prev = build({ messages: 5, headerSalt: 'req_111' })
    const cur = build({ messages: 5, headerSalt: 'req_222' })
    const d = firstDivergence(cacheOrder(prev), cacheOrder(cur))
    assert.ok(d.appendOnly, 'a header-only change must not count as a divergence')
    const c = classifyTurn(prev, cur)
    assert.strictEqual(c.boundary, c.lastBreakpointIndex)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-write').length, 0)
    assert.ok(c.elements.every(e => e.path !== 'tools' || e.cls === 'cache-read'))
  })

  // The marker moves onto each new last message, so the previous turn's entry ends at ITS last
  // message: everything up to there is re-read and only the appended message is written. Snapping to
  // the CURRENT request's markers instead gave 0.907 structural against 0.996 billed.
  test('appending a message re-reads everything the previous turn stored and writes only the new one', () => {
    const prev = build({ messages: 5 })
    const cur = build({ messages: 6 })
    const c = classifyTurn(prev, cur)
    const written = c.elements.filter(e => e.cls !== 'cache-read')
    assert.deepStrictEqual(written.map(e => `${e.path}[${e.idx}]`), ['messages[5]'])
    assert.ok(c.elements.every(e => e.path !== 'tools' || e.cls === 'cache-read'))
    assert.strictEqual(c.bytes.freshInput, 0, 'the trailing marker keeps the new message cacheable')
  })

  test('content past the last breakpoint is uncached fresh input', () => {
    const prev = build({ messages: 5 })
    const cur = build({ messages: 6 })
    // Drop the trailing marker: the new message is then outside every cacheable region.
    const ordered = cacheOrder(cur).map(e => ({ ...e, breakpoint: e.path === 'messages' ? false : e.breakpoint }))
    const c = classifyTurn(prev, ordered)
    const fresh = c.elements.filter(e => e.cls === 'fresh-input')
    assert.deepStrictEqual(fresh.map(e => `${e.path}[${e.idx}]`), ['messages[5]'])
  })

  // Cache order is the whole point: messages sit AFTER tools and system in the prefix even though
  // the wire body puts them first, so a changed message cannot evict a tool schema.
  test('a change confined to messages never moves tools or system out of the cached region', () => {
    const prev = build({ messages: 8 })
    const cur = build({ messages: 8, msgSalt: { 5: 'CHANGED' } })
    const c = classifyTurn(prev, cur)
    for (const el of c.elements) {
      if (el.path === 'tools' || el.path === 'system') {
        assert.strictEqual(el.cls, 'cache-read', `${el.path}[${el.idx}] must stay cached`)
      }
    }
    assert.strictEqual(c.divergence.element?.path, 'messages')
    assert.strictEqual(c.divergence.element?.idx, 5)
  })

  // The snap-back rule: surviving = up to the last breakpoint BEFORE the change, not up to the
  // change. system[4] is a breakpoint, so a change at the message right after it costs nothing
  // earlier; a change at system[4] itself falls back to system[3].
  test('the boundary snaps back to the last breakpoint before the divergence', () => {
    const prev = build({ messages: 8 })
    const cur = build({ messages: 8, sysSalt: 'v2' })
    const c = classifyTurn(prev, cur)
    // system[2] changed and no breakpoint precedes it, so nothing survives.
    assert.strictEqual(c.divergence.element?.path, 'system')
    assert.strictEqual(c.divergence.element?.idx, 2)
    assert.strictEqual(c.boundary, -1)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-read').length, 0)
  })

  test('a change one element after a breakpoint costs everything back to that breakpoint', () => {
    const els = build({ messages: 8 })
    const ordered = cacheOrder(els)
    const sys4 = posOf(els, 'system', 4)
    assert.ok(ordered[sys4].breakpoint, 'precondition: system[4] is a breakpoint')
    // The boundary is snapped against the PREVIOUS request's markers, which here are the same shape.
    const boundary = survivingBoundary(ordered, sys4 + 1)
    assert.strictEqual(boundary, sys4, 'survives up to and including the preceding breakpoint')
  })

  test('a changed tool evicts everything, since no breakpoint precedes the tools', () => {
    const prev = build({ messages: 4 })
    const cur = build({ messages: 4, toolSalt: 'v2' })
    const c = classifyTurn(prev, cur)
    assert.strictEqual(c.boundary, -1)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-read').length, 0)
  })

  test('the first request of a stream caches nothing', () => {
    const c = classifyTurn(null, build({ messages: 3 }))
    assert.strictEqual(c.boundary, -1)
    assert.strictEqual(c.elements.filter(e => e.cls === 'cache-read').length, 0)
  })

  test('removing content breaks the prefix rather than reading as append-only', () => {
    const prev = build({ messages: 8 })
    const cur = build({ messages: 4 })
    const d = firstDivergence(cacheOrder(prev), cacheOrder(cur))
    assert.ok(!d.appendOnly)
  })

  test('every element is classified exactly once and the byte totals partition the request', () => {
    const c = classifyTurn(build({ messages: 5 }), build({ messages: 7 }))
    const total = c.bytes.cacheRead + c.bytes.cacheWrite + c.bytes.freshInput
    const sum = c.elements.reduce((n, e) => n + e.bytes, 0)
    assert.strictEqual(total, sum, 'the three buckets must partition the elements exactly')
    assert.strictEqual(c.elements.length, new Set(c.elements.map(e => e.position)).size)
  })

  test('lastBreakpoint finds the final cache_control marker', () => {
    const ordered = cacheOrder(build({ messages: 6 }))
    assert.strictEqual(lastBreakpoint(ordered), ordered.length - 1)
  })

  // The billed usage is the oracle; the structural diff explains it. A disagreement must surface.
  test('reconcile agrees with a warm billed turn and flags a disagreement', () => {
    const c = classifyTurn(build({ messages: 20 }), build({ messages: 21 }))
    const warm = reconcile(c, { cacheReadTokens: 315507, cacheCreateTokens: 1201 })
    assert.ok(warm.agrees, `expected agreement, structural ${warm.structuralShare} billed ${warm.billedShare}`)
    const cold = reconcile(c, { cacheReadTokens: 0, cacheCreateTokens: 640000 })
    assert.ok(!cold.agrees)
    assert.ok(cold.delta > 0.5)
  })
})
