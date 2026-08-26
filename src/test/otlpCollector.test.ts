import * as assert from 'assert'
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { OutputChannelLike } from '../vscodeCompat'
import { OtlpCollector } from '../otlpCollector'
import { SessionStore } from '../sessionStore'

// The collector only calls appendLine; the extension host's real OutputChannel
// was removed (TRDD-6E6416B8), so a no-op OutputChannelLike is all it needs.
function mockOutputChannel(): OutputChannelLike {
  return { appendLine: () => {} }
}

// ── Mock SessionStore ──

function mockStore() {
  const addedSpans: unknown[] = []
  return {
    addedSpans,
    addSpan: (s: unknown) => { addedSpans.push(s) },
    getSpans: () => addedSpans,
    getSummary: () => ({}),
    clear: () => { addedSpans.length = 0 },
    export: () => ({ spans: addedSpans, summary: {} }),
  } as unknown as SessionStore & { addedSpans: unknown[] }
}

// ── HTTP helpers ──

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function postRaw(port: number, path: string, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve({ status: res.statusCode! }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Test data ──

function validOtlpPayload(spans: Array<{ name: string; traceId?: string; spanId?: string }>) {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: spans.map((s, i) => ({
          traceId: s.traceId ?? 'trace-' + i,
          spanId: s.spanId ?? 'span-' + i,
          name: s.name,
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000001000000000',
          attributes: [],
          status: { code: 0 }
        }))
      }]
    }]
  }
}

// ── Tests ──

suite('OtlpCollector', () => {
  let collector: OtlpCollector
  let store: ReturnType<typeof mockStore>
  let output: ReturnType<typeof mockOutputChannel>
  // Port 0 = let the OS hand out a free one, then read it back. The previous
  // `14318 + random(1000)` guessed a port and then RE-BOUND that same guess in every setup, which
  // races the previous listener's release: measured, this spec failed 1 run in 200 with `socket
  // hang up`, on whichever test hit the race, and a fresh random port each run meant it never
  // reproduced twice the same way. A guessed port can also collide with anything else on the box.
  let TEST_PORT = 0

  setup(async () => {
    store = mockStore()
    output = mockOutputChannel()
    collector = new OtlpCollector(0, store as unknown as SessionStore, output)
    await collector.start()
    TEST_PORT = collector.boundPort
  })

  teardown(async () => {
    await collector.stop()
  })

  test('starts and listens on configured port', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [] })
    assert.strictEqual(res.status, 200)
  })

  test('processes valid OTLP trace payload', async () => {
    const payload = validOtlpPayload([
      { name: 'invoke_agent', traceId: 't1', spanId: 's1' },
      { name: 'tool/read_file', traceId: 't1', spanId: 's2' }
    ])
    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)
  })

  test('skips spans with missing required fields', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            { name: 'valid', traceId: 't1', spanId: 's1', startTimeUnixNano: '0', endTimeUnixNano: '0', attributes: [] },
            { name: null, traceId: 't1' },  // missing spanId and name
            { traceId: 't1', spanId: 's3' },  // missing name
          ]
        }]
      }]
    }
    await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(store.addedSpans.length, 1)
  })

  test('handles non-JSON body gracefully', async () => {
    const res = await postRaw(TEST_PORT, '/v1/traces', 'not json at all')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles empty POST body', async () => {
    const res = await postRaw(TEST_PORT, '/v1/traces', '')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles non-trace JSON payload', async () => {
    const res = await postJson(TEST_PORT, '/v1/metrics', { someMetric: 42 })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles GET request without crashing', async () => {
    return new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${TEST_PORT}/v1/traces`, (res) => {
        assert.strictEqual(res.statusCode, 200)
        res.resume()
        res.on('end', resolve)
      }).on('error', reject)
    })
  })

  test('processes multiple spans from single request', async () => {
    const payload = validOtlpPayload([
      { name: 'invoke_agent' },
      { name: 'tool/grep_search' },
      { name: 'tool/read_file' },
      { name: 'chat' },
    ])
    await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(store.addedSpans.length, 4)
  })

  test('drops Codex websocket trace spans at ingest', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'codex-trace',
              spanId: 'prompt-span',
              name: 'codex.user_prompt',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000000000000',
              attributes: [],
            },
            {
              traceId: 'codex-trace',
              spanId: 'websocket-span',
              name: 'codex.websocket_event',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual((store.addedSpans as Array<{ name: string }>).map(s => s.name), ['codex.user_prompt'])
  })

  test('handles payload with empty resourceSpans', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [] })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 0)
  })

  test('handles malformed resourceSpans structure', async () => {
    const res = await postJson(TEST_PORT, '/v1/traces', { resourceSpans: [{ scopeSpans: null }] })
    assert.strictEqual(res.status, 200)
  })

  test('stop resolves cleanly', async () => {
    await collector.stop()
    // Second stop should also resolve without error
    await collector.stop()
  })

  test('processes codex log payload and groups by prompt-to-response session when traceId is missing', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-123' } },
                { key: 'user_prompt', value: { stringValue: 'Fix latency chart' } },
              ],
            },
            {
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.response' } },
                { key: 'conversation.id', value: { stringValue: 'conv-123' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 321 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const first = store.addedSpans[0] as { traceId: string; name: string }
    const second = store.addedSpans[1] as { traceId: string; name: string }
    assert.strictEqual(first.name, 'codex.user_prompt')
    assert.strictEqual(second.name, 'codex.response')
    assert.strictEqual(first.traceId, 'codex:conv-123:prompt-1')
    assert.strictEqual(second.traceId, 'codex:conv-123:prompt-1')
  })

  test('drops Codex websocket log events at ingest', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'codex-log-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'prompt', value: { stringValue: 'Check websocket filter' } },
              ],
            },
            {
              traceId: 'codex-log-trace',
              spanId: 'websocket-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.websocket_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'event.kind', value: { stringValue: 'response.created' } },
              ],
            },
            {
              traceId: 'codex-log-trace',
              spanId: 'sse-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-websocket' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(
      (store.addedSpans as Array<{ name: string }>).map(s => s.name),
      ['codex.user_prompt', 'codex.sse_event']
    )
  })

  test('does not create a Codex session for startup logs before the user prompt', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'startup-trace',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.conversation_starts' } },
                { key: 'conversation.id', value: { stringValue: 'conv-startup' } },
              ],
            },
            {
              traceId: 'prewarm-trace',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-startup' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
                { key: 'input_token_count', value: { intValue: 20475 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string }> }>
    assert.deepStrictEqual(spans.map(s => s.traceId), ['startup-trace', 'prewarm-trace'])
    assert.ok(spans.every(s => !s.attributes.some(a => a.key === 'codex.session.id')))
  })

  test('folds child Codex turns into the active prompt-to-response session', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'prompt-trace',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-main' } },
                { key: 'prompt', value: { stringValue: 'check for calls to dispose()' } },
              ],
            },
            {
              traceId: 'child-trace',
              spanId: 'child-ttft',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.turn_ttft' } },
                { key: 'conversation.id', value: { stringValue: 'conv-child' } },
                { key: 'turn.id', value: { stringValue: 'turn-child' } },
                { key: 'duration_ms', value: { intValue: 3435 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>
    assert.strictEqual(spans[0].traceId, spans[1].traceId)
    assert.ok(spans[1].attributes.some(a => a.key === 'codex.turn.id' && a.value.stringValue === 'turn-child'))
  })

  test('keeps one codex prompt together when log records have different OTEL trace IDs', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'otel-trace-a',
              spanId: 'prompt-span',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'prompt', value: { stringValue: 'Fix trace split' } },
              ],
            },
            {
              traceId: 'otel-trace-b',
              spanId: 'response-span',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'event.kind', value: { stringValue: 'response.completed' } },
              ],
            },
            {
              traceId: 'otel-trace-c',
              spanId: 'tool-span',
              timeUnixNano: '1700000002000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.tool_result' } },
                { key: 'conversation.id', value: { stringValue: 'conv-split' } },
                { key: 'tool_name', value: { stringValue: 'shell_command' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const traceIds = new Set((store.addedSpans as Array<{ traceId: string }>).map(s => s.traceId))
    assert.strictEqual(traceIds.size, 1)
    assert.ok([...traceIds][0].startsWith('codex:conv-split:'))
  })

  test('normalizes raw trace spans that share a Codex log OTEL trace ID', async () => {
    const logPayload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              traceId: 'raw-tool-trace',
              spanId: 'prompt-log',
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-tool-trace' } },
                { key: 'prompt', value: { stringValue: 'run a command' } },
              ],
            },
            {
              traceId: 'raw-tool-trace',
              spanId: 'tool-result-log',
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.tool_result' } },
                { key: 'conversation.id', value: { stringValue: 'conv-tool-trace' } },
                { key: 'tool_name', value: { stringValue: 'exec_command' } },
              ],
            },
          ],
        }],
      }],
    }
    await postJson(TEST_PORT, '/v1/logs', logPayload)
    const sessionTraceId = (store.addedSpans[0] as { traceId: string }).traceId

    const tracePayload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'raw-tool-trace',
              spanId: 'exec-span',
              name: 'exec_command',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000002000000000',
              attributes: [],
            },
          ],
        }],
      }],
    }
    const res = await postJson(TEST_PORT, '/v1/traces', tracePayload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const execSpan = store.addedSpans[2] as { traceId: string; name: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }
    assert.strictEqual(execSpan.name, 'exec_command')
    assert.strictEqual(execSpan.traceId, sessionTraceId)
    assert.ok(execSpan.attributes.some(a => a.key === 'codex.session.id' && a.value.stringValue === sessionTraceId))
    assert.ok(execSpan.attributes.some(a => a.key === 'otel.trace_id' && a.value.stringValue === 'raw-tool-trace'))
  })

  test('starts a new codex log session for the next user prompt in the same conversation', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
                { key: 'prompt', value: { stringValue: 'First prompt' } },
              ],
            },
            {
              timeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
              ],
            },
            {
              timeUnixNano: '1700000010000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.user_prompt' } },
                { key: 'conversation.id', value: { stringValue: 'conv-two-prompts' } },
                { key: 'prompt', value: { stringValue: 'Second prompt' } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 3)

    const spans = store.addedSpans as Array<{ traceId: string }>
    assert.strictEqual(spans[0].traceId, spans[1].traceId)
    assert.notStrictEqual(spans[0].traceId, spans[2].traceId)
  })

  test('normalizes codex trace spans by thread and turn IDs', async () => {
    const payload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: 'raw-trace-1',
              spanId: 'turn-span',
              name: 'turn',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'thread.id', value: { stringValue: 'thread-123' } },
                { key: 'turn.id', value: { stringValue: 'turn-abc' } },
                { key: 'otel.name', value: { stringValue: 'session_task.turn' } },
              ],
            },
            {
              traceId: 'raw-trace-1',
              spanId: 'llm-span',
              parentSpanId: 'turn-span',
              name: 'handle_responses',
              startTimeUnixNano: '1700000000100000000',
              endTimeUnixNano: '1700000000900000000',
              attributes: [
                { key: 'thread.id', value: { stringValue: 'thread-123' } },
                { key: 'turn.id', value: { stringValue: 'turn-abc' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 12 } },
              ],
            },
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/traces', payload)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(store.addedSpans.length, 2)

    const spans = store.addedSpans as Array<{ traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }>
    assert.strictEqual(spans[0].traceId, 'codex:thread-123:turn-abc')
    assert.strictEqual(spans[1].traceId, 'codex:thread-123:turn-abc')
    assert.ok(spans[0].attributes.some(a => a.key === 'codex.session.id' && a.value.stringValue === 'codex:thread-123:turn-abc'))
  })

  // Claude Code 2.1.206 emits BARE log-event names (`api_request` — the `claude_code.`-prefixed
  // strings do not exist in that binary), while older builds/docs use the prefixed form. A
  // prefixed-only gate silently dropped EVERY rich event (verified: 0 api_request spans in an
  // 81MB store). The gate must accept both spellings and always STORE the prefixed span name,
  // because spanSummarizer keys its rich-event handling on `claude_code.api_request` etc.
  test('ingests Claude rich log events under both bare and prefixed event names', async () => {
    /** One api_request log record; `name` is the on-the-wire event name spelling under test. */
    const rec = (name: string, sid: string) => ({
      timeUnixNano: '1700000000000000000',
      attributes: [
        { key: 'event.name', value: { stringValue: name } },
        { key: 'session.id', value: { stringValue: sid } },
        { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
      ],
    })
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            rec('api_request', 'sess-bare'),            // CC 2.1.206 spelling
            rec('claude_code.api_request', 'sess-pre'), // documented/older spelling
            rec('compaction', 'sess-bare'),
            rec('api_error', 'sess-bare'),
          ],
        }],
      }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    const spans = store.addedSpans as Array<{ name: string; traceId: string }>
    assert.deepStrictEqual(spans.map(s => s.name), [
      'claude_code.api_request',
      'claude_code.api_request',
      'claude_code.compaction',
      'claude_code.api_error',
    ])
    // Keyed by session.id — CC 2.1.206 propagates an OTLP traceId on log records that would
    // otherwise orphan rich events into a pseudo-session away from their llm_request spans.
    assert.deepStrictEqual(spans.map(s => s.traceId), ['sess-bare', 'sess-pre', 'sess-bare', 'sess-bare'])
  })

  test('ingests Claude tool_result carrying the snake_case tool_name attribute', async () => {
    // 2.1.206 attaches `tool_name` (snake_case); older builds `tool.name`. Both must pass the
    // tool_result gate, which requires a non-empty tool name.
    const rec = (toolAttrKey: string) => ({
      timeUnixNano: '1700000000000000000',
      traceId: 'deadbeefdeadbeefdeadbeefdeadbeef', // the propagated context that must NOT win
      attributes: [
        { key: 'event.name', value: { stringValue: 'tool_result' } },
        { key: 'session.id', value: { stringValue: 'sess-tools' } },
        { key: toolAttrKey, value: { stringValue: 'Bash' } },
      ],
    })
    const payload = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [rec('tool_name'), rec('tool.name')] }] }],
    }

    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    const spans = store.addedSpans as Array<{ name: string; traceId: string }>
    assert.deepStrictEqual(spans.map(s => s.name), ['claude_code.tool_result', 'claude_code.tool_result'])
    assert.deepStrictEqual(spans.map(s => s.traceId), ['sess-tools', 'sess-tools'])
  })
})

// ── TRDD-AMEA4O4Z: the log-event sink — gated-out events are PERSISTED, never discarded ──
suite('OtlpCollector — log-event sink', () => {
  let TEST_PORT = 0 // OS-assigned, same reason as the suite above
  let collector: OtlpCollector
  let sinkDir: string

  setup(async () => {
    sinkDir = fs.mkdtempSync(path.join(os.tmpdir(), `al-sink-${process.pid}-`))
    collector = new OtlpCollector(0, mockStore() as unknown as SessionStore, mockOutputChannel(), sinkDir)
    await collector.start()
    TEST_PORT = collector.boundPort
  })

  teardown(async () => {
    await collector.stop()
    fs.rmSync(sinkDir, { recursive: true, force: true })
  })

  test('a gate-rejected event (user_prompt) is counted AND persisted to the sink with attrs intact', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            attributes: [
              { key: 'event.name', value: { stringValue: 'user_prompt' } },
              { key: 'session.id', value: { stringValue: 'sess-sink' } },
              { key: 'prompt', value: { stringValue: 'what time is it' } },
            ],
          }],
        }],
      }],
    }
    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    // Counter unchanged behavior: still counted as not-ingested-as-span.
    assert.deepStrictEqual(collector.getDroppedLogEvents(), { user_prompt: 1 })
    // NEW behavior: the full event survives in the day bucket.
    const buckets = fs.readdirSync(sinkDir).filter(f => f.endsWith('.ndjsonl'))
    assert.strictEqual(buckets.length, 1)
    const lines = fs.readFileSync(path.join(sinkDir, buckets[0]), 'utf-8').trim().split('\n')
    assert.strictEqual(lines.length, 1)
    const rec = JSON.parse(lines[0]) as { ev: string; session?: string; attrs: Record<string, unknown>; tsEvent?: number }
    assert.strictEqual(rec.ev, 'user_prompt')
    assert.strictEqual(rec.session, 'sess-sink')
    assert.strictEqual(rec.attrs['prompt'], 'what time is it')
    assert.strictEqual(rec.tsEvent, 1_700_000_000_000)
  })

  test('an ACCEPTED rich event (api_request) is NOT written to the sink — only rejected events are', async () => {
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1700000000000000000',
            attributes: [
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'session.id', value: { stringValue: 'sess-rich' } },
            ],
          }],
        }],
      }],
    }
    const res = await postJson(TEST_PORT, '/v1/logs', payload)
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(collector.getDroppedLogEvents(), {})
    assert.deepStrictEqual(fs.readdirSync(sinkDir), [])
  })
})
