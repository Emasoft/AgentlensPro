import * as assert from 'assert'
import { serializeBranch, DEFAULT_THRESHOLD_BYTES, type SerialNode, type SerialHeader } from '../shared/branchSerialize'

const HEADER: SerialHeader = { sessionId: 'sess-1', slug: 'my-proj', source: 'claude_code', dataSource: 'log' }

suite('branchSerialize (TRDD-4CH9QLAH — copy fully-expanded branch tree)', () => {
  test('header carries session id + project slug + source/dataSource', () => {
    // The dump must be self-describing: who/what/where at the top.
    const { text } = serializeBranch(HEADER, { kind: 'session', title: 'session sess-1' })
    assert.ok(text.includes('# session: sess-1   project: my-proj'))
    assert.ok(text.includes('source: claude_code/log'))
    assert.ok(text.includes('# AgentlensPro branch dump'))
  })

  test('OTEL match key ⟨span/req/trace⟩ is appended only for ids that are present', () => {
    // Grep-able correlation on the node line; absent ids are omitted, not printed empty.
    const root: SerialNode = {
      kind: 'session', title: 'session sess-1', match: { traceId: 'tr-9' },
      children: [
        { kind: 'llm', title: 'Answer', match: { spanId: 'sp-1', requestId: 'rq-1' } },
        { kind: 'tool', title: 'Bash', match: { spanId: 'sp-2' } },
      ],
    }
    const { text } = serializeBranch(HEADER, root)
    assert.ok(text.includes('⟨trace=tr-9⟩'), 'session trace key')
    assert.ok(text.includes('⟨span=sp-1 req=rq-1⟩'), 'llm span+req key')
    assert.ok(text.includes('⟨span=sp-2⟩'), 'tool span-only key')
    assert.ok(!text.includes('req=undefined') && !text.includes('trace=undefined'), 'no empty ids')
  })

  test('no match key suffix when a node has no ids', () => {
    // Scope the assertion to the NODE line: the header legend legitimately shows ⟨span=… req=… trace=…⟩.
    const { text } = serializeBranch(HEADER, { kind: 'event', title: 'user input' })
    const nodeLine = text.split('\n').find((l) => l.includes('user input'))
    assert.ok(nodeLine && !nodeLine.includes('⟨'), 'no bracket on a node without ids')
  })

  test('tree connectors reflect child order (├─ for non-last, └─ for last)', () => {
    const root: SerialNode = {
      kind: 'session', title: 'root',
      children: [
        { kind: 'llm', title: 'first' },
        { kind: 'llm', title: 'last' },
      ],
    }
    const { text } = serializeBranch(HEADER, root)
    assert.ok(text.includes('├─ first'), 'non-last uses ├─')
    assert.ok(text.includes('└─ last'), 'last uses └─')
  })

  test('nested subagent branch indents under a vertical guide', () => {
    const root: SerialNode = {
      kind: 'session', title: 'root',
      children: [
        { kind: 'llm', title: 'turn-1' },
        { kind: 'session', title: 'subagent child', children: [{ kind: 'llm', title: 'nested' }] },
      ],
    }
    const { text } = serializeBranch(HEADER, root)
    // The subagent is the last child, so its descendants sit under 3 spaces (no trailing bar).
    assert.ok(/└─ .*subagent child/.test(text))
    assert.ok(text.includes('   └─ nested'), 'nested node indented under last-child subtree')
  })

  test('small body is inlined with its label', () => {
    const root: SerialNode = { kind: 'llm', title: 'Answer', bodies: [{ label: 'response', text: 'hello world' }] }
    const { text, dumps } = serializeBranch(HEADER, root)
    assert.ok(text.includes('response: hello world'))
    assert.strictEqual(dumps.length, 0)
  })

  test('multi-line small body keeps its extra lines aligned', () => {
    const root: SerialNode = { kind: 'llm', title: 'Answer', bodies: [{ label: 'x', text: 'line1\nline2' }] }
    const { text } = serializeBranch(HEADER, root)
    assert.ok(text.includes('x: line1'))
    assert.ok(text.includes('line2'))
  })

  test('over-threshold body becomes a @@DUMP@@ placeholder + a dump entry (thresholds on bytes, reports chars)', () => {
    const big = 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
    const root: SerialNode = { kind: 'tool', title: 'Bash', bodies: [{ label: 'result', text: big }] }
    const { text, dumps } = serializeBranch(HEADER, root)
    assert.strictEqual(dumps.length, 1, 'one dump extracted')
    assert.strictEqual(dumps[0].content, big, 'dump carries the full body')
    assert.ok(text.includes(`@@DUMP:${dumps[0].id}@@`), 'placeholder references the dump id')
    assert.ok(text.includes(`[${big.length} chars → dump:`), 'human-readable char count')
    assert.ok(!text.includes(big), 'the big body is NOT inlined')
  })

  test('multi-byte body thresholds on UTF-8 bytes, not code-point count', () => {
    // '€' is 3 UTF-8 bytes. A string just under threshold in chars but over in bytes must dump.
    const s = '€'.repeat(Math.ceil((DEFAULT_THRESHOLD_BYTES + 3) / 3))
    const root: SerialNode = { kind: 'tool', title: 'T', bodies: [{ label: 'r', text: s }] }
    const { dumps } = serializeBranch(HEADER, root)
    assert.strictEqual(dumps.length, 1, 'byte-length over threshold → dump even though char count is lower')
  })

  test('custom threshold is honored', () => {
    const root: SerialNode = { kind: 'tool', title: 'T', bodies: [{ label: 'r', text: 'abcdef' }] }
    const inline = serializeBranch(HEADER, root, { thresholdBytes: 100 })
    const dumped = serializeBranch(HEADER, root, { thresholdBytes: 3 })
    assert.strictEqual(inline.dumps.length, 0)
    assert.strictEqual(dumped.dumps.length, 1)
  })

  test('dump ids are unique across multiple over-threshold bodies', () => {
    const big = 'y'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
    const root: SerialNode = {
      kind: 'session', title: 'root',
      children: [
        { kind: 'tool', title: 'A', bodies: [{ label: 'r', text: big }] },
        { kind: 'tool', title: 'B', bodies: [{ label: 'r', text: big }] },
      ],
    }
    const { dumps } = serializeBranch(HEADER, root)
    assert.strictEqual(dumps.length, 2)
    assert.notStrictEqual(dumps[0].id, dumps[1].id, 'ids differ')
  })

  test('empty branch (session, no children/bodies) still yields a valid header + one node line', () => {
    const { text, dumps } = serializeBranch(HEADER, { kind: 'session', title: 'session sess-1' })
    assert.ok(text.includes('● session sess-1'))
    assert.strictEqual(dumps.length, 0)
    assert.ok(text.endsWith('\n'))
  })
})
