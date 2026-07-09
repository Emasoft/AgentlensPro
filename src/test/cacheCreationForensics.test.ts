import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanCacheCreationEvents, buildCacheCreationReport, buildExpensiveWritesTrace, buildCacheBreakGapReport,
  formatExpensiveWrites, formatCostPeaks, DEFAULT_BODIES_DIR,
} from '../cacheCreationForensics'

// TRDD-CCFORNSC — REAL tests for the cache_creation forensic diagnostics: no mocked bodies, no mocked
// join. Every test writes real request/response JSON files to a tmp dir and drives the actual bounded
// disk scan + the actual previous_message_id correlation. The only "skip if absent" test is the one
// that reads the machine's real ~/.agentlens/otel-bodies directory (absent in CI).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-'))
suiteTeardown(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })

let fileCounter = 0
function writeJson(name: string, body: unknown): string {
  const p = path.join(tmpDir, `${++fileCounter}-${name}`)
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

// A minimal but real Anthropic response body — the exact shape scanCacheCreationEvents parses.
function responseBody(id: string, opts: { cacheCreate?: number; cacheRead?: number; input?: number; output?: number; model?: string; ephemeral5m?: number; ephemeral1h?: number } = {}) {
  return {
    id,
    model: opts.model,
    usage: {
      input_tokens: opts.input ?? 10,
      output_tokens: opts.output ?? 5,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreate ?? 0,
      cache_creation: (opts.ephemeral5m !== undefined || opts.ephemeral1h !== undefined)
        ? { ephemeral_5m_input_tokens: opts.ephemeral5m ?? 0, ephemeral_1h_input_tokens: opts.ephemeral1h ?? 0 }
        : undefined,
    },
  }
}

// A minimal but real Anthropic request body carrying the previous_message_id join key — the exact
// shape buildCallContext / scanCacheCreationEvents' request indexer parses.
function requestBody(opts: {
  previousMessageId?: string
  sessionId?: string
  accountUuid?: string
  model?: string
  content?: unknown[]
} = {}) {
  return {
    model: opts.model ?? 'claude-opus-4-8',
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: opts.accountUuid ?? 'acct-1', session_id: opts.sessionId ?? 'sess-1' }) },
    diagnostics: opts.previousMessageId ? { previous_message_id: opts.previousMessageId } : undefined,
    system: [{ type: 'text', text: 'You are a helpful assistant working on a task.' }],
    tools: [{ name: 'Bash', description: 'run a shell command' }, { name: 'Read', description: 'read a file' }],
    messages: [{ role: 'user', content: opts.content ?? [{ type: 'text', text: 'do the task' }] }],
  }
}

function setMtime(filePath: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo)
  fs.utimesSync(filePath, t, t)
}

suite('cacheCreationForensics — scanCacheCreationEvents (the previous_message_id join)', () => {
  test('attributes a response to its session/account via the request that FOLLOWS it', async () => {
    const respPath = writeJson('a.response.json', responseBody('msg_join_1', { cacheCreate: 5000, model: 'claude-haiku-4-5' }))
    writeJson('a.request.json', requestBody({ previousMessageId: 'msg_join_1', sessionId: 'sess-A', accountUuid: 'acct-A', model: 'claude-haiku-4-5' }))

    const { events, coverage } = await scanCacheCreationEvents({ bodiesDir: tmpDir })
    const ev = events.find(e => e.responseRef === respPath)
    assert.ok(ev, 'expected the cache_creation event to be scanned')
    assert.strictEqual(ev!.attributed, true)
    assert.strictEqual(ev!.sessionId, 'sess-A')
    assert.strictEqual(ev!.accountUuid, 'acct-A')
    assert.strictEqual(ev!.cacheCreateTokens, 5000)
    assert.ok(ev!.costUsd > 0, 'a known model with cache_creation tokens must price above 0')
    assert.strictEqual(coverage.dirExists, true)
  })

  test('a response with no following request is UNATTRIBUTED, not dropped', async () => {
    const respPath = writeJson('b.response.json', responseBody('msg_orphan_1', { cacheCreate: 3000, model: 'claude-opus-4-8' }))
    // Deliberately no matching request file for msg_orphan_1.
    const { events } = await scanCacheCreationEvents({ bodiesDir: tmpDir })
    const ev = events.find(e => e.responseRef === respPath)
    assert.ok(ev)
    assert.strictEqual(ev!.attributed, false)
    assert.strictEqual(ev!.sessionId, undefined)
    assert.strictEqual(ev!.accountUuid, undefined)
    // Falls back to the response body's own model when unattributed.
    assert.strictEqual(ev!.model, 'claude-opus-4-8')
  })

  test('responses with cache_creation_input_tokens <= 0 are excluded from the scan', async () => {
    const respPath = writeJson('c.response.json', responseBody('msg_zero_1', { cacheCreate: 0, cacheRead: 900 }))
    const { events } = await scanCacheCreationEvents({ bodiesDir: tmpDir })
    assert.ok(!events.some(e => e.responseRef === respPath))
  })

  test('an unrecognized model prices as 0 cost, never throws', async () => {
    const respPath = writeJson('d.response.json', responseBody('msg_unknown_model', { cacheCreate: 1200, model: 'totally-unknown-model-xyz' }))
    const { events } = await scanCacheCreationEvents({ bodiesDir: tmpDir })
    const ev = events.find(e => e.responseRef === respPath)
    assert.ok(ev)
    assert.strictEqual(ev!.costUsd, 0)
  })

  test('windowHours excludes files older than the cutoff; omitting it includes everything', async () => {
    const scopedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-window-'))
    try {
      const oldResp = path.join(scopedDir, 'old.response.json')
      fs.writeFileSync(oldResp, JSON.stringify(responseBody('msg_old', { cacheCreate: 2000, model: 'claude-haiku-4-5' })))
      setMtime(oldResp, 10 * 3_600_000) // 10h ago

      const recentResp = path.join(scopedDir, 'recent.response.json')
      fs.writeFileSync(recentResp, JSON.stringify(responseBody('msg_recent', { cacheCreate: 2000, model: 'claude-haiku-4-5' })))
      // mtime defaults to "now" — no setMtime call needed.

      const windowed = await scanCacheCreationEvents({ bodiesDir: scopedDir, windowHours: 1 })
      assert.ok(windowed.events.some(e => e.responseRef === recentResp))
      assert.ok(!windowed.events.some(e => e.responseRef === oldResp))
      assert.strictEqual(windowed.coverage.windowHours, 1)

      const unwindowed = await scanCacheCreationEvents({ bodiesDir: scopedDir })
      assert.ok(unwindowed.events.some(e => e.responseRef === recentResp))
      assert.ok(unwindowed.events.some(e => e.responseRef === oldResp))
    } finally {
      fs.rmSync(scopedDir, { recursive: true, force: true })
    }
  })

  test('a missing bodies directory reports dirExists:false and empty events, never throws', async () => {
    const missing = path.join(tmpDir, 'does-not-exist-' + Math.random().toString(36).slice(2))
    const { events, coverage } = await scanCacheCreationEvents({ bodiesDir: missing })
    assert.strictEqual(events.length, 0)
    assert.strictEqual(coverage.dirExists, false)
    assert.ok(coverage.note.includes('OTEL_LOG_RAW_API_BODIES'))
  })

  test('DEFAULT_BODIES_DIR resolves under the home directory (the documented default)', () => {
    assert.ok(DEFAULT_BODIES_DIR.includes('.agentlens'))
    assert.ok(DEFAULT_BODIES_DIR.includes('otel-bodies'))
  })
})

suite('cacheCreationForensics — buildCacheCreationReport (WHO is burning cache_creation)', () => {
  test('ranks groups heaviest cache_creation first, grouped by session by default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-report-'))
    try {
      const r1 = path.join(dir, 'r1.response.json')
      fs.writeFileSync(r1, JSON.stringify(responseBody('msg_r1', { cacheCreate: 1000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'r1.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_r1', sessionId: 'small-session', model: 'claude-haiku-4-5' })))

      const r2 = path.join(dir, 'r2.response.json')
      fs.writeFileSync(r2, JSON.stringify(responseBody('msg_r2', { cacheCreate: 50000, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'r2.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_r2', sessionId: 'big-session', model: 'claude-opus-4-8' })))

      const report = await buildCacheCreationReport({ bodiesDir: dir })
      assert.strictEqual(report.groupBy, 'session')
      assert.ok(report.groups.length >= 2)
      assert.strictEqual(report.groups[0].key, 'big-session')
      assert.strictEqual(report.groups[0].cacheCreateTokens, 50000)
      assert.strictEqual(report.totalCacheCreateTokens, 51000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('groups by account / model / time when requested', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-groupby-'))
    try {
      const resp = path.join(dir, 'g1.response.json')
      fs.writeFileSync(resp, JSON.stringify(responseBody('msg_g1', { cacheCreate: 700, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'g1.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_g1', sessionId: 'sX', accountUuid: 'acct-Z', model: 'claude-haiku-4-5' })))

      const byAccount = await buildCacheCreationReport({ bodiesDir: dir, groupBy: 'account' })
      assert.ok(byAccount.groups.some(g => g.key === 'acct-Z' && g.cacheCreateTokens === 700))

      const byModel = await buildCacheCreationReport({ bodiesDir: dir, groupBy: 'model' })
      assert.ok(byModel.groups.some(g => g.key === 'claude-haiku-4-5' && g.cacheCreateTokens === 700))

      const byTime = await buildCacheCreationReport({ bodiesDir: dir, groupBy: 'time' })
      assert.strictEqual(byTime.groups.length, 1)
      assert.match(byTime.groups[0].key, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the unattributed bucket is explicit and separate from attributed group totals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-unattr-'))
    try {
      // Attributed event.
      fs.writeFileSync(path.join(dir, 'u1.response.json'), JSON.stringify(responseBody('msg_u1', { cacheCreate: 400, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'u1.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_u1', sessionId: 'sess-known', model: 'claude-haiku-4-5' })))
      // Orphan (last-turn) event — no request references it.
      fs.writeFileSync(path.join(dir, 'u2.response.json'), JSON.stringify(responseBody('msg_u2_orphan', { cacheCreate: 999, model: 'claude-opus-4-8' })))

      const report = await buildCacheCreationReport({ bodiesDir: dir })
      assert.strictEqual(report.unattributed.events, 1)
      assert.strictEqual(report.unattributed.cacheCreateTokens, 999)
      assert.ok(report.unattributed.note.length > 0)
      // Attributed total still reflects both events combined — the unattributed figure is a labeled
      // SUBSET view, not a silently-dropped one.
      assert.strictEqual(report.totalCacheCreateTokens, 400 + 999)
      const knownGroup = report.groups.find(g => g.key === 'sess-known')
      assert.ok(knownGroup)
      assert.strictEqual(knownGroup!.cacheCreateTokens, 400)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('topN caps the returned groups (a bounded response, not the whole corpus)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-topn-'))
    try {
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(dir, `t${i}.response.json`), JSON.stringify(responseBody(`msg_t${i}`, { cacheCreate: 100 + i, model: 'claude-haiku-4-5' })))
        fs.writeFileSync(path.join(dir, `t${i}.request.json`), JSON.stringify(requestBody({ previousMessageId: `msg_t${i}`, sessionId: `sess-t${i}`, model: 'claude-haiku-4-5' })))
      }
      const report = await buildCacheCreationReport({ bodiesDir: dir, topN: 2 })
      assert.strictEqual(report.groups.length, 2)
      // Heaviest-first: sess-t4 (104 tokens) then sess-t3 (103 tokens).
      assert.strictEqual(report.groups[0].key, 'sess-t4')
      assert.strictEqual(report.groups[1].key, 'sess-t3')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('cacheCreationForensics — buildCacheCreationReport D2 cost-peak bucket selection', () => {
  test('bucket=output ranks groups by OUTPUT tokens (billed ~5x), not cache_creation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-bucket-out-'))
    try {
      // Session A: a huge cache_creation write, tiny output.
      fs.writeFileSync(path.join(dir, 'a.response.json'), JSON.stringify(responseBody('msg_bA', { cacheCreate: 90000, output: 50, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'a.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_bA', sessionId: 'sessA-cc', model: 'claude-opus-4-8' })))
      // Session B: a tiny cache_creation write, but a huge OUTPUT-token spike — the real cost peak here.
      fs.writeFileSync(path.join(dir, 'b.response.json'), JSON.stringify(responseBody('msg_bB', { cacheCreate: 1000, output: 80000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'b.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_bB', sessionId: 'sessB-out', model: 'claude-haiku-4-5' })))

      const byCache = await buildCacheCreationReport({ bodiesDir: dir })
      assert.strictEqual(byCache.bucket, 'cache_creation')
      assert.strictEqual(byCache.groups[0].key, 'sessA-cc')

      const byOutput = await buildCacheCreationReport({ bodiesDir: dir, bucket: 'output' })
      assert.strictEqual(byOutput.bucket, 'output')
      assert.strictEqual(byOutput.groups[0].key, 'sessB-out')
      assert.strictEqual(byOutput.groups[0].bucketValue, 80000)
      // The output-spike list surfaces session B's write explicitly, regardless of the active bucket.
      assert.ok(byCache.outputSpikes.top.some(s => s.sessionId === 'sessB-out' && s.outputTokens === 80000))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bucket=total ranks by input+cacheRead+cacheCreate+output combined', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-bucket-total-'))
    try {
      // Session A: cache_creation 5000, everything else tiny.
      fs.writeFileSync(path.join(dir, 'a.response.json'), JSON.stringify(responseBody('msg_tA', { cacheCreate: 5000, cacheRead: 0, input: 5, output: 5, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'a.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_tA', sessionId: 'sessA-total', model: 'claude-haiku-4-5' })))
      // Session B: a smaller cache_creation (4000) but a much bigger cache_read — its TOTAL beats A's.
      fs.writeFileSync(path.join(dir, 'b.response.json'), JSON.stringify(responseBody('msg_tB', { cacheCreate: 4000, cacheRead: 20000, input: 5, output: 5, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'b.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_tB', sessionId: 'sessB-total', model: 'claude-haiku-4-5' })))

      const byCache = await buildCacheCreationReport({ bodiesDir: dir })
      assert.strictEqual(byCache.groups[0].key, 'sessA-total') // 5000 > 4000 on cache_creation alone

      const byTotal = await buildCacheCreationReport({ bodiesDir: dir, bucket: 'total' })
      assert.strictEqual(byTotal.bucket, 'total')
      assert.strictEqual(byTotal.groups[0].key, 'sessB-total') // 4000+20000+10 > 5000+10 on total tokens
      assert.strictEqual(byTotal.groups[0].bucketValue, byTotal.groups[0].totalTokens)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bucket=billable_weighted prices via the real per-model rate; an unknown model contributes 0, never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-bucket-bw-'))
    try {
      fs.writeFileSync(path.join(dir, 'u.response.json'), JSON.stringify(responseBody('msg_bw', { cacheCreate: 5000, output: 100, model: 'totally-unknown-model-xyz' })))
      fs.writeFileSync(path.join(dir, 'u.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_bw', sessionId: 'sess-unknown', model: 'totally-unknown-model-xyz' })))
      fs.writeFileSync(path.join(dir, 'k.response.json'), JSON.stringify(responseBody('msg_bw2', { cacheCreate: 5000, output: 100, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'k.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_bw2', sessionId: 'sess-known', model: 'claude-opus-4-8' })))

      const report = await buildCacheCreationReport({ bodiesDir: dir, bucket: 'billable_weighted' })
      const unknownGroup = report.groups.find(g => g.key === 'sess-unknown')
      const knownGroup = report.groups.find(g => g.key === 'sess-known')
      assert.ok(unknownGroup && knownGroup)
      assert.strictEqual(unknownGroup!.bucketValue, 0)
      assert.ok(knownGroup!.bucketValue > 0, 'a known model with real usage must price above 0')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the report totals include input/output tokens alongside cache_creation/cache_read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-bucket-totals-'))
    try {
      fs.writeFileSync(path.join(dir, 'x.response.json'), JSON.stringify(responseBody('msg_tot', { cacheCreate: 2000, cacheRead: 300, input: 40, output: 60, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'x.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_tot', sessionId: 'sess-totals', model: 'claude-haiku-4-5' })))
      const report = await buildCacheCreationReport({ bodiesDir: dir })
      assert.strictEqual(report.totalInputTokens, 40)
      assert.strictEqual(report.totalOutputTokens, 60)
      assert.strictEqual(report.totalCacheCreateTokens, 2000)
      assert.strictEqual(report.totalCacheReadTokens, 300)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("groupBy='cause' is rejected — that dimension is served by buildCauseCostPeakReport, not this function", async () => {
    const badOpts = { groupBy: 'cause' } as unknown as Parameters<typeof buildCacheCreationReport>[0]
    await assert.rejects(() => buildCacheCreationReport(badOpts), /buildCauseCostPeakReport/)
  })

  test('formatCostPeaks renders table/markdown/timeline; json returns the object identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-bucket-fmt-'))
    try {
      fs.writeFileSync(path.join(dir, 'f.response.json'), JSON.stringify(responseBody('msg_fmt2', { cacheCreate: 4000, output: 200, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'f.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_fmt2', sessionId: 'sess-fmt2', model: 'claude-opus-4-8' })))
      const report = await buildCacheCreationReport({ bodiesDir: dir, bucket: 'output' })
      assert.strictEqual(formatCostPeaks(report, 'json'), report)
      for (const fmt of ['table', 'markdown', 'timeline'] as const) {
        const out = formatCostPeaks(report, fmt) as { format: string; text: string }
        assert.strictEqual(out.format, fmt)
        assert.ok(out.text.length > 0)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('cacheCreationForensics — buildExpensiveWritesTrace (WHAT is inside the huge writes)', () => {
  test('breaks the biggest write down by image/tool_result/text/system/tool-catalog tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-trace-'))
    try {
      fs.writeFileSync(path.join(dir, 'big.response.json'), JSON.stringify(responseBody('msg_big', { cacheCreate: 30000, cacheRead: 10, input: 5, output: 3, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'big.request.json'), JSON.stringify(requestBody({
        previousMessageId: 'msg_big', sessionId: 'sess-big', accountUuid: 'acct-big', model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'analyze this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) } },
          { type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(2000) },
        ],
      })))

      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir })
      assert.strictEqual(trace.events.length, 1)
      const ev = trace.events[0]
      assert.strictEqual(ev.attributed, true)
      assert.strictEqual(ev.sessionId, 'sess-big')
      assert.strictEqual(ev.accountUuid, 'acct-big')
      assert.ok(ev.composition, 'expected a resolved composition')
      assert.strictEqual(ev.composition!.imageCount, 1)
      assert.ok(ev.composition!.imageTokens > 0)
      assert.ok(ev.composition!.toolResultTokens > 0)
      assert.ok(ev.composition!.textTokens > 0)
      assert.ok(ev.composition!.systemTokens > 0)
      assert.strictEqual(ev.composition!.toolCatalogCount, 2) // Bash + Read
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is POINTER-ONLY: never leaks base64 image bytes or the raw user_id token blob', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-pointer-'))
    try {
      const secretBase64 = 'B'.repeat(3000)
      fs.writeFileSync(path.join(dir, 'p1.response.json'), JSON.stringify(responseBody('msg_p1', { cacheCreate: 8000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'p1.request.json'), JSON.stringify(requestBody({
        previousMessageId: 'msg_p1', sessionId: 'sess-p1', accountUuid: 'acct-p1', model: 'claude-haiku-4-5',
        content: [
          { type: 'text', text: 'sensitive prompt text should not leak either' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: secretBase64 } },
        ],
      })))

      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir })
      const serialized = JSON.stringify(trace)
      assert.ok(!serialized.includes(secretBase64), 'base64 image bytes must never cross the boundary')
      assert.ok(!serialized.includes('sensitive prompt text'), 'raw block text must never cross the boundary')
      assert.ok(!serialized.includes('dev-1'), 'the device_id from metadata.user_id must never cross the boundary')
      // account_uuid / session_id ARE derived identifiers, not secrets — they are expected to appear.
      assert.ok(serialized.includes('sess-p1'))
      assert.ok(serialized.includes('acct-p1'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('composition is null when the owning request body could not be resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-nulltrace-'))
    try {
      fs.writeFileSync(path.join(dir, 'orphan.response.json'), JSON.stringify(responseBody('msg_orphan_trace', { cacheCreate: 4000, model: 'claude-opus-4-8' })))
      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir })
      assert.strictEqual(trace.events.length, 1)
      assert.strictEqual(trace.events[0].attributed, false)
      assert.strictEqual(trace.events[0].composition, null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('minCacheCreate filters out events below the floor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-floor-'))
    try {
      fs.writeFileSync(path.join(dir, 'small.response.json'), JSON.stringify(responseBody('msg_small', { cacheCreate: 100, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'large.response.json'), JSON.stringify(responseBody('msg_large', { cacheCreate: 9000, model: 'claude-haiku-4-5' })))
      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir, minCacheCreate: 5000 })
      assert.strictEqual(trace.events.length, 1)
      assert.strictEqual(trace.events[0].cacheCreateTokens, 9000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('cacheCreationForensics — buildCacheBreakGapReport (TTL expiry vs cache break)', () => {
  test('tier split sums ephemeral_5m / ephemeral_1h across ALL scanned cache_creation events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-tier-'))
    try {
      fs.writeFileSync(path.join(dir, 'tier1.response.json'), JSON.stringify(responseBody('msg_tier1', { cacheCreate: 700, ephemeral5m: 700, ephemeral1h: 0, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'tier2.response.json'), JSON.stringify(responseBody('msg_tier2', { cacheCreate: 300, ephemeral5m: 0, ephemeral1h: 300, model: 'claude-haiku-4-5' })))

      const report = await buildCacheBreakGapReport({ bodiesDir: dir, minCacheCreate: 0 })
      assert.strictEqual(report.tierSplit.totalCacheCreateTokens, 1000)
      assert.strictEqual(report.tierSplit.ephemeral5mTokens, 700)
      assert.strictEqual(report.tierSplit.ephemeral1hTokens, 300)
      assert.strictEqual(report.tierSplit.ephemeral5mPct, 70)
      assert.strictEqual(report.tierSplit.ephemeral1hPct, 30)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('classifies the gap since the previous same-session call into the right TTL/break bucket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-gap-'))
    try {
      const sid = 'sess-gap'
      // Three big writes in the SAME session: first-call, then a fast break (<4.5m), then a TTL-window gap (4.5-6m).
      const r1 = path.join(dir, 'g1.response.json')
      fs.writeFileSync(r1, JSON.stringify(responseBody('msg_gap1', { cacheCreate: 150000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'g1.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_gap1', sessionId: sid, model: 'claude-haiku-4-5' })))
      setMtime(r1, 20 * 60_000) // 20 minutes ago (oldest)

      const r2 = path.join(dir, 'g2.response.json')
      fs.writeFileSync(r2, JSON.stringify(responseBody('msg_gap2', { cacheCreate: 150000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'g2.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_gap2', sessionId: sid, model: 'claude-haiku-4-5' })))
      setMtime(r2, 18 * 60_000) // 2 minutes after g1 -> <4.5m bucket

      const r3 = path.join(dir, 'g3.response.json')
      fs.writeFileSync(r3, JSON.stringify(responseBody('msg_gap3', { cacheCreate: 150000, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'g3.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_gap3', sessionId: sid, model: 'claude-haiku-4-5' })))
      setMtime(r3, 13 * 60_000) // 5 minutes after g2 -> 4.5-6m (=5m TTL) bucket

      const report = await buildCacheBreakGapReport({ bodiesDir: dir })
      assert.strictEqual(report.bigEventCount, 3)
      const byBucket = new Map(report.gapBuckets.map(b => [b.bucket, b]))
      assert.strictEqual(byBucket.get('first-call(no prev)')!.events, 1)
      assert.strictEqual(byBucket.get('<4.5m')!.events, 1)
      assert.strictEqual(byBucket.get('4.5-6m(=5m TTL)')!.events, 1)
      assert.strictEqual(byBucket.get('6-15m')!.events, 0)
      assert.ok(report.interpretation.length >= 3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('minCacheCreate defaults to 100000 and excludes smaller writes from the gap classification', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-gapfloor-'))
    try {
      fs.writeFileSync(path.join(dir, 'small.response.json'), JSON.stringify(responseBody('msg_gapsmall', { cacheCreate: 500, model: 'claude-haiku-4-5' })))
      const report = await buildCacheBreakGapReport({ bodiesDir: dir })
      assert.strictEqual(report.minCacheCreate, 100_000)
      assert.strictEqual(report.bigEventCount, 0)
      // The tier split still reflects the small event even though it's excluded from gap bucketing.
      assert.strictEqual(report.tierSplit.totalCacheCreateTokens, 500)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unattributed responses are grouped into one shared pseudo-session, never crashing the gap calc', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-gapunattr-'))
    try {
      fs.writeFileSync(path.join(dir, 'orphan1.response.json'), JSON.stringify(responseBody('msg_orph1', { cacheCreate: 120000, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'orphan2.response.json'), JSON.stringify(responseBody('msg_orph2', { cacheCreate: 130000, model: 'claude-opus-4-8' })))
      const report = await buildCacheBreakGapReport({ bodiesDir: dir })
      assert.strictEqual(report.bigEventCount, 2)
      const total = report.gapBuckets.reduce((n, b) => n + b.events, 0)
      assert.strictEqual(total, 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('cacheCreationForensics — buildExpensiveWritesTrace (D1 filters + backward chain + formats)', () => {
  test('filters by sessionId and surfaces OUTPUT-token spikes via minOutputTokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-d1filter-'))
    try {
      // Session A: a big OUTPUT-token write (output is billed ~5x — sometimes the culprit, not cache_create).
      fs.writeFileSync(path.join(dir, 'a.response.json'), JSON.stringify(responseBody('msg_dA', { cacheCreate: 8000, output: 50000, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'a.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_dA', sessionId: 'sessA', model: 'claude-opus-4-8' })))
      // Session B: a modest write, tiny output.
      fs.writeFileSync(path.join(dir, 'b.response.json'), JSON.stringify(responseBody('msg_dB', { cacheCreate: 9000, output: 100, model: 'claude-haiku-4-5' })))
      fs.writeFileSync(path.join(dir, 'b.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_dB', sessionId: 'sessB', model: 'claude-haiku-4-5' })))

      const onlyA = await buildExpensiveWritesTrace({ bodiesDir: dir, sessionId: 'sessA' })
      assert.strictEqual(onlyA.events.length, 1)
      assert.strictEqual(onlyA.events[0].sessionId, 'sessA')
      assert.strictEqual(onlyA.events[0].outputTokens, 50000)

      const spikes = await buildExpensiveWritesTrace({ bodiesDir: dir, minOutputTokens: 40000 })
      assert.strictEqual(spikes.events.length, 1)
      assert.strictEqual(spikes.events[0].sessionId, 'sessA')

      const byModel = await buildExpensiveWritesTrace({ bodiesDir: dir, model: 'haiku' })
      assert.ok(byModel.events.every(e => (e.model ?? '').includes('haiku')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('chainDepth attaches the ordered backward CONTEXT CHAIN of preceding turns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-d1chain-'))
    try {
      const sid = 'sess-chain'
      const base = Date.now() - 3_600_000
      // 3 requests + 3 responses; the middle write is the biggest. Attribution of M2 comes from R3.prev.
      const mk = (i: number, cc: number, prev: string) => {
        const rp = path.join(dir, `r${i}.response.json`)
        fs.writeFileSync(rp, JSON.stringify(responseBody(`msg_c${i}`, { cacheCreate: cc, model: 'claude-opus-4-8' })))
        fs.utimesSync(rp, new Date(base + i * 60_000 + 30_000), new Date(base + i * 60_000 + 30_000))
        const qp = path.join(dir, `r${i}.request.json`)
        fs.writeFileSync(qp, JSON.stringify(requestBody({ previousMessageId: prev, sessionId: sid, model: 'claude-opus-4-8' })))
        fs.utimesSync(qp, new Date(base + i * 60_000), new Date(base + i * 60_000))
      }
      mk(1, 5000, 'msg_root')
      mk(2, 100000, 'msg_c1')  // biggest; attributed via R3.prev = msg_c2
      mk(3, 6000, 'msg_c2')

      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir, chainDepth: 5, minCacheCreate: 50000 })
      const big = trace.events.find(e => e.cacheCreateTokens === 100000)
      assert.ok(big, 'the biggest write must be traced')
      assert.strictEqual(big!.sessionId, sid)
      assert.ok(big!.backwardChain && big!.backwardChain.length >= 1, 'a backward chain of preceding turns must be attached')
      // The chain turns are ordered oldest→newest and carry pointer-only composition summaries.
      for (const t of big!.backwardChain!) assert.ok(typeof t.bodyRef === 'string' && t.ts.length > 0)
      assert.strictEqual(trace.filters.chainDepth, 5)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('formatExpensiveWrites renders table/markdown/timeline; json returns the object', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforensics-d1fmt-'))
    try {
      fs.writeFileSync(path.join(dir, 'f.response.json'), JSON.stringify(responseBody('msg_fmt', { cacheCreate: 12000, output: 300, model: 'claude-opus-4-8' })))
      fs.writeFileSync(path.join(dir, 'f.request.json'), JSON.stringify(requestBody({ previousMessageId: 'msg_fmt', sessionId: 'sess-fmt', model: 'claude-opus-4-8' })))
      const trace = await buildExpensiveWritesTrace({ bodiesDir: dir })
      assert.strictEqual(formatExpensiveWrites(trace, 'json'), trace)
      for (const fmt of ['table', 'markdown', 'timeline'] as const) {
        const out = formatExpensiveWrites(trace, fmt) as { format: string; text: string }
        assert.strictEqual(out.format, fmt)
        assert.ok(out.text.length > 0)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('cacheCreationForensics — real machine data', () => {
  // 🐌 slow — scans the real ~/.agentlens/otel-bodies directory (thousands of files). Skips when the
  // directory is absent (CI / a machine that never enabled OTEL_LOG_RAW_API_BODIES).
  test('scans the REAL OTEL bodies directory without crashing and reports honest coverage', async function () {
    if (!fs.existsSync(DEFAULT_BODIES_DIR)) { this.skip(); return }
    this.timeout(60_000)
    const report = await buildCacheCreationReport({ windowHours: 5 })
    assert.ok(report.coverage.dirExists)
    assert.ok(report.coverage.note.length > 0)
    assert.ok(report.totalCacheCreateTokens >= 0)
    assert.ok(report.totalCacheCreateTokens >= report.unattributed.cacheCreateTokens)
  })
})
