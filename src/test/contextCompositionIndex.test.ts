import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCallComposition, buildSessionComposition, readResponseUsage,
  ContextCompositionIndex, type RequestRef,
} from '../contextCompositionIndex'
import { callBodyRegistry } from '../rawBodyContext'
import { estimateTokensFromBytes } from '../tokenEstimator'

// TRDD-CTXQUERY — REAL tests for the lazy context-composition query layer. The image-parsing test
// runs against an ACTUAL raw body in ~/.agentlens/otel-bodies (no mock of the parse) and skips when
// that dir is absent (CI). The logic tests write real body JSON files to a tmp dir and drive the real
// buildCallContext parse + the real registry — no mocks anywhere.

const OTEL_DIR = path.join(os.homedir(), '.agentlens', 'otel-bodies')

// A minimal but real Anthropic Messages request body (the exact shape buildCallContext parses).
interface Body { model: string; metadata: { user_id: string }; system: Array<{ type: string; text: string }>; tools: unknown[]; messages: Array<{ role: string; content: unknown }> }
function makeBody(sessionId: string, contentBlocks: unknown[], opts: { model?: string; accountUuid?: string } = {}): Body {
  return {
    model: opts.model ?? 'claude-opus-4-8',
    metadata: { user_id: JSON.stringify({ device_id: 'dev', account_uuid: opts.accountUuid ?? 'acct-1', session_id: sessionId }) },
    system: [{ type: 'text', text: 'You are a helpful assistant working on a task.' }],
    tools: [],
    messages: [{ role: 'user', content: contentBlocks }],
  }
}
function imageBlock(base64Len: number, media = 'image/png'): unknown {
  return { type: 'image', source: { type: 'base64', media_type: media, data: 'a'.repeat(base64Len) } }
}
function textBlock(text: string): unknown { return { type: 'text', text } }

// One tmp dir for the whole file (created once at load); cleaned up after ALL suites via the root
// teardown below — a per-suite teardown would delete it out from under the later suites.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxcomp-'))
suiteTeardown(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })
function writeBody(name: string, body: unknown): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

suite('contextCompositionIndex — image token accounting', () => {
  // 🐌 slow — reads a multi-MB real body off disk. Skips when the OTEL-body dir is absent (CI).
  test('detects the 8 stuck images (~525k tokens) in a REAL ANIME2SVG-style body', async function () {
    if (!fs.existsSync(OTEL_DIR)) { this.skip(); return }
    this.timeout(30_000)
    // Largest request files carry the base64 images — scan a bounded top slice for one with images.
    const files = fs.readdirSync(OTEL_DIR).filter(n => n.endsWith('.request.json'))
      .map(n => ({ n, sz: fs.statSync(path.join(OTEL_DIR, n)).size }))
      .sort((a, b) => b.sz - a.sz).slice(0, 12)
    let found: string | null = null
    for (const { n, sz } of files) {
      if (sz > 30 * 1024 * 1024) { continue }
      const cc = await buildCallComposition(path.join(OTEL_DIR, n), 1, Date.now())
      if (!cc || cc.images.count === 0) { continue }
      found = n
      // The founding ANIME2SVG bodies carry 8 images ≈ 525k tokens; assert the module surfaces that weight.
      if (cc.images.count >= 8) { assert.ok(cc.images.tokens > 400_000, `expected >400k image tokens, got ${cc.images.tokens}`) }
      // Every image block is re-classified to the 'image' category with a media type — not the lost '[image]' placeholder.
      const imgs = cc.blocks.filter(b => b.isImage)
      assert.strictEqual(imgs.length, cc.images.count)
      assert.ok(imgs.every(b => b.kind === 'image' && b.tokens > 1000))
      break
    }
    if (!found) { this.skip() }
  })

  test('image tokens come from base64 length, not the placeholder (bytes/4)', async () => {
    const p = writeBody('img.request.json', makeBody('sess-img', [textBlock('do this'), imageBlock(8000)]))
    const cc = await buildCallComposition(p, 1, 1000)
    assert.ok(cc)
    assert.strictEqual(cc.images.count, 1)
    assert.strictEqual(cc.images.tokens, estimateTokensFromBytes(8000)) // 2000, not ~2
    assert.strictEqual(cc.sessionId, 'sess-img')
    assert.strictEqual(cc.accountUuid, 'acct-1')
  })
})

suite('contextCompositionIndex — session composition + resident tracking', () => {
  test('an image resident across 2 calls is counted as re-read on both', async () => {
    const s = 'sess-resident'
    const r1 = writeBody('r1.request.json', makeBody(s, [textBlock('turn one'), imageBlock(8000)]))
    const r2 = writeBody('r2.request.json', makeBody(s, [textBlock('turn two'), imageBlock(8000)]))
    const refs: RequestRef[] = [{ bodyRef: r1, ts: 1 }, { bodyRef: r2, ts: 2 }]
    const comp = await buildSessionComposition(s, refs)
    assert.strictEqual(comp.calls.length, 2)
    assert.strictEqual(comp.images.count, 1)
    assert.strictEqual(comp.images.residentTurns, 2)
    // Re-read weight = image tokens × the two turns it rode forward.
    assert.strictEqual(comp.images.cumulativeReadTokens, estimateTokensFromBytes(8000) * 2)
    assert.ok(comp.images.cumulativeReadCostUsd >= 0)
    // The resident image shows up in the general blob list too, ranked by wasted re-read cost.
    const imgBlob = comp.residentBlobs.find(b => b.isImage)
    assert.ok(imgBlob, 'expected an image resident blob')
    assert.strictEqual(imgBlob!.residentTurns, 2)
  })

  test('exact response usage overrides the request-side estimate', async () => {
    const s = 'sess-exact'
    const req = writeBody('e1.request.json', makeBody(s, [textBlock('hello'), imageBlock(4000)]))
    const resp = writeBody('e1.response.json', { id: 'msg_x', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, service_tier: 'standard' } })
    const usage = await readResponseUsage(resp)
    assert.ok(usage)
    assert.strictEqual(usage!.cacheReadTokens, 900)
    const comp = await buildSessionComposition(s, [{ bodyRef: req, ts: 1, responseRef: resp }])
    assert.strictEqual(comp.callsWithExactUsage, 1)
    const call = comp.calls[0]
    assert.strictEqual(call.tokenSource, 'exact')
    assert.strictEqual(call.contextTokens, 100 + 900 + 0) // input + cacheRead + cacheCreate (output excluded)
  })

  test('missing response body falls back to the estimate (no throw)', async () => {
    const s = 'sess-noresp'
    const req = writeBody('n1.request.json', makeBody(s, [textBlock('hi')]))
    const comp = await buildSessionComposition(s, [{ bodyRef: req, ts: 1, responseRef: path.join(tmpDir, 'does-not-exist.response.json') }])
    assert.strictEqual(comp.callsWithExactUsage, 0)
    assert.strictEqual(comp.calls[0].tokenSource, 'estimated')
    assert.ok(comp.calls[0].contextTokens > 0)
  })
})

suite('contextCompositionIndex — query engine via the registry (lazy path)', () => {
  test('imageReport / findResidentBlobs / queryBlocks / getBlockContent over registry-fed bodies', async () => {
    const s = 'sess-query-' + Math.random().toString(36).slice(2, 8)
    const r1 = writeBody('q1.request.json', makeBody(s, [textBlock('first turn text'), imageBlock(8000)]))
    const r2 = writeBody('q2.request.json', makeBody(s, [textBlock('second turn text'), imageBlock(8000)]))
    // Feed the shared registry exactly as the OTLP ingestor does (pointers only).
    callBodyRegistry.record(s, { kind: 'request', bodyRef: r1, spanId: 'span1', ts: 1 })
    callBodyRegistry.record(s, { kind: 'request', bodyRef: r2, spanId: 'span2', ts: 2 })
    const index = new ContextCompositionIndex()
    const projectFor = () => '/proj/anime'

    const img = await index.imageReport(s, projectFor)
    assert.strictEqual(img.sessions.length, 1)
    assert.strictEqual(img.sessions[0].images, 1)
    assert.strictEqual(img.sessions[0].residentTurns, 2)

    const blobs = await index.findResidentBlobs(s, { kind: 'image' }, projectFor)
    assert.ok(blobs.blobs.length >= 1)
    assert.ok(blobs.blobs.every(b => b.kind === 'image'))

    const q = await index.queryBlocks({ sessionId: s, kind: 'image' }, 'kind', projectFor)
    assert.strictEqual(q.groups.length, 1)
    assert.strictEqual(q.groups[0].key, 'image')
    assert.strictEqual(q.groups[0].count, 2) // one image per call × 2 calls

    // Block order in each call: [0] system prompt, [1] user text, [2] image.
    // get_block_content: the image block returns metadata + ref, NEVER the base64 text.
    const imgBlock = await index.getBlockContent(s, 1, 2)
    assert.ok('isImage' in imgBlock && imgBlock.isImage === true)
    assert.ok(!('text' in imgBlock) || imgBlock.text === undefined, 'image block must not return base64/text')
    // A text block returns its real text.
    const txtBlock = await index.getBlockContent(s, 1, 1)
    assert.ok('text' in txtBlock && typeof txtBlock.text === 'string' && txtBlock.text.includes('first turn text'))
  })
})
