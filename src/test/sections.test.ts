// The sectioner's ONE contract: reconstruction is BYTE-IDENTICAL to the source (TRDD-K3WDPR7M).
//
// If that ever fails we have a body store that cannot give back what it was given — the worst
// possible outcome for an observability tool, and one that would look fine until someone actually
// needed a body back. So the suite verifies against REAL captured bodies on disk, not just synthetic
// fixtures: the synthetic cases pin the edge conditions, the real ones prove it on the data we ship.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MIN_BLOB_BYTES, reassemble, scanValue, sectionize, sha256 } from '../store/sections'

/** Round-trip a raw body through the sectioner and assert byte-identity. Returns the sectioning. */
function roundTrip(raw: string) {
  const s = sectionize(raw)
  const back = reassemble(s.parts, (sha) => s.blobs.get(sha))
  assert.strictEqual(back, raw, 'reconstruction must be byte-identical to the source')
  return s
}

const big = (c: string) => c.repeat(MIN_BLOB_BYTES + 50) // a span large enough to be content-addressed

suite('sections — byte-exact reconstruction', () => {
  test('a trivial object round-trips', () => {
    roundTrip('{"model":"opus","stream":true}')
  })

  test('exact whitespace and separators survive (we slice, we never re-serialize)', () => {
    // JSON.parse -> JSON.stringify would silently normalize all of this away. Slicing cannot.
    const raw = '{\n  "a" :  1,\n\t"b" : [ 1 ,  2 ]  ,\n  "c":{"d" : null}\n}'
    roundTrip(raw)
  })

  test('strings containing braces, brackets and quotes do not desynchronize the scan', () => {
    // The classic sectioner bug: a `{` inside a string is counted as nesting and every subsequent
    // span is off by one, corrupting the whole body.
    const raw = JSON.stringify({ s: `${big('x')} {"not":"json"} [1,2] "quoted"`, after: 'ok' })
    const s = roundTrip(raw)
    assert.strictEqual((JSON.parse(reassemble(s.parts, (h) => s.blobs.get(h))) as { after: string }).after, 'ok')
  })

  test('a trailing backslash before the closing quote does not eat the quote', () => {
    // `"C:\\"` — if the escape pair is not consumed as ONE unit, the scanner reads the closing quote
    // as escaped, runs to the end of the document, and the body is unrecoverable.
    roundTrip(JSON.stringify({ p: `C:\\`, next: big('n') }))
  })

  test('escaped quotes, newlines and unicode inside strings round-trip', () => {
    roundTrip(JSON.stringify({ s: `he said "hi"\n\ttab é \u{1f600} ${big('u')}`, n: 1 }))
  })

  test('an empty array and an empty object round-trip', () => {
    roundTrip('{"a":[],"b":{},"c":[[]],"d":0}')
  })

  test('numbers keep their exact source spelling', () => {
    // 1.0 -> "1" and 1e3 -> "1000" under a re-serialize round-trip. Slicing preserves the bytes.
    roundTrip('{"a":1.0,"b":1e3,"c":-0.0,"d":1.230,"e":1E+2}')
  })
})

suite('sections — content addressing', () => {
  test('a top-level ARRAY is split element-wise — not just `messages`', () => {
    // The whole point: `tools` is ~342 KB and byte-identical on every request. A messages-only
    // sectioner would re-store those 342 KB every turn and leave most of the redundancy behind.
    const raw = JSON.stringify({ tools: [{ t: big('t') }, { t: big('u') }], messages: [{ m: big('m') }] })
    const s = roundTrip(raw)
    const paths = s.parts.filter((p) => p.kind === 'blob').map((p) => (p as { path: string }).path)
    assert.ok(paths.includes('tools'), 'tools must be sectioned')
    assert.ok(paths.includes('messages'), 'messages must be sectioned')
  })

  test('IDENTICAL elements collapse to ONE blob — this is the whole saving', () => {
    const item = { t: big('t') }
    const raw = JSON.stringify({ tools: [item, item, item] })
    const s = roundTrip(raw)
    const blobParts = s.parts.filter((p) => p.kind === 'blob')
    assert.strictEqual(blobParts.length, 3, 'three occurrences...')
    assert.strictEqual(s.blobs.size, 1, '...but ONE stored span')
  })

  test('the in-clear index (path/idx/size/hash) is available WITHOUT decompressing anything', () => {
    const raw = JSON.stringify({ messages: [{ m: big('a') }, { m: big('b') }] })
    const s = sectionize(raw)
    const blobs = s.parts.filter((p) => p.kind === 'blob') as Array<{ path: string; idx: number; n: number; sha: string }>
    assert.deepStrictEqual(blobs.map((b) => [b.path, b.idx]), [['messages', 0], ['messages', 1]])
    for (const b of blobs) {
      assert.ok(b.n > MIN_BLOB_BYTES)
      assert.strictEqual(b.sha.length, 64)
    }
  })

  test('spans below the threshold stay literal — a hash row must not cost more than it saves', () => {
    const s = sectionize('{"model":"claude-opus-4-8","stream":true,"max_tokens":32000}')
    assert.strictEqual(s.blobs.size, 0, 'tiny scalars are not worth content-addressing')
  })

  test('a missing blob THROWS — it must never hand back a plausible-looking corrupt body', () => {
    const s = sectionize(JSON.stringify({ messages: [{ m: big('m') }] }))
    assert.throws(() => reassemble(s.parts, () => undefined), /missing blob/)
  })
})

suite('sections — against REAL captured bodies', () => {
  // The synthetic cases pin the edge conditions; these prove it on the data we actually ship.
  const dir = path.join(os.homedir(), '.agentlens', 'otel-bodies')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.json')).slice(0, 25)
  } catch { /* no corpus on this machine — the test self-skips below */ }

  test('every real body reconstructs byte-identically (whole-body sha256)', function () {
    if (files.length === 0) { this.skip(); return }
    let totalRaw = 0
    let totalUnique = 0
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8')
      const s = sectionize(raw)
      const back = reassemble(s.parts, (sha) => s.blobs.get(sha))
      // sha256 of the REBUILT bytes vs the SOURCE bytes — the same gate the store enforces on ingest.
      assert.strictEqual(sha256(back), sha256(raw), `${f} did not round-trip byte-identically`)
      totalRaw += Buffer.byteLength(raw, 'utf8')
      for (const span of s.blobs.values()) totalUnique += Buffer.byteLength(span, 'utf8')
    }
    // Not an assertion on the ratio (that is the bake-off's job) — just proof the redundancy is real.
    assert.ok(totalUnique < totalRaw, `unique ${totalUnique} must be < raw ${totalRaw}`)
  })
})

suite('scanValue', () => {
  test('finds the exact extent of each value kind', () => {
    const cases: Array<[string, number]> = [
      ['"abc"', 5], ['123', 3], ['-1.5e3', 6], ['true', 4], ['null', 4],
      ['{"a":{"b":[1,2]}}', 17], ['[1,[2,[3]]]', 11], ['"a\\"b"', 6],
    ]
    for (const [src, end] of cases) assert.strictEqual(scanValue(src, 0), end, src)
  })

  test('an unterminated string or object is a hard error, never a silent truncation', () => {
    assert.throws(() => scanValue('"abc', 0), /unterminated/)
    assert.throws(() => scanValue('{"a":1', 0), /unterminated/)
  })
})
