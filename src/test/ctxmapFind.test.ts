import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'
import { readBodyText, readBody } from '../capturedBody'
import { firstOperand } from '../cli/ctxmapCli'

// `--find` gained a raw-text prefilter so it stops parsing every capture. The prefilter is only
// sound if it decodes EXACTLY what the parser would: reading the file as utf8 instead silently
// mojibakes every gzipped capture, and the substring test then misses text that is really there.
// A false negative here is indistinguishable from "the text is not in your context", which is the
// question the tool exists to answer.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmap-find-'))
}

suite('--find prefilter — decodes what the parser decodes', () => {
  test('readBodyText gunzips, so a needle in a compressed capture is still found', () => {
    const dir = tmpDir()
    const needle = 'AGENTLENS-NEEDLE-1234'
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: needle }] })

    const plain = path.join(dir, 'plain.request.json')
    const gzipped = path.join(dir, 'gz.request.json')
    fs.writeFileSync(plain, body)
    fs.writeFileSync(gzipped, zlib.gzipSync(Buffer.from(body, 'utf8')))

    assert.ok(readBodyText(plain).includes(needle))
    assert.ok(readBodyText(gzipped).includes(needle), 'gzipped capture must decode before the substring test')

    // The bug this guards: a plain utf8 read of the gzipped file cannot contain the needle.
    assert.ok(!fs.readFileSync(gzipped, 'utf8').includes(needle),
      'precondition — a raw utf8 read really does miss it, which is why readBodyText exists')

    // And the text path agrees with the parse path.
    assert.deepStrictEqual(readBody(gzipped), JSON.parse(body))
  })

  test('the escaped spelling is what matches for a non-ASCII needle', () => {
    const dir = tmpDir()
    const needle = 'café→'
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: needle }] })
    const f = path.join(dir, 'uni.request.json')
    fs.writeFileSync(f, body)

    const raw = readBodyText(f)
    const escaped = JSON.stringify(needle).slice(1, -1)
    assert.ok(raw.includes(needle) || raw.includes(escaped),
      'the prefilter accepts either spelling precisely so escaping cannot cause a miss')
  })
})

suite('firstOperand — flags may precede the capture path', () => {
  test('finds the path whether flags come before or after it', () => {
    assert.strictEqual(firstOperand(['a.json']), 'a.json')
    assert.strictEqual(firstOperand(['--refresh', 'a.json']), 'a.json')
    assert.strictEqual(firstOperand(['a.json', '--refresh']), 'a.json')
    assert.strictEqual(firstOperand(['--estimate', '--refresh', 'a.json']), 'a.json')
  })

  test('does not mistake a valued flag’s value for the path', () => {
    assert.strictEqual(firstOperand(['--top', '40', 'a.json']), 'a.json')
    assert.strictEqual(firstOperand(['--out', 'r.md', 'a.json']), 'a.json')
    assert.strictEqual(firstOperand(['--limit', '5']), undefined)
  })

  test('returns undefined when only flags were given', () => {
    assert.strictEqual(firstOperand(['--refresh']), undefined)
    assert.strictEqual(firstOperand([]), undefined)
  })
})
