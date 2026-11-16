import * as http from 'http'
import type { AddressInfo } from 'net'

// A minimal MCP stub: answers initialize, tools/list, tools/call over plain JSON (the CLI accepts plain-JSON
// responses on the Streamable-HTTP endpoint). Real HTTP. Shared by the spawned-CLI tests (cliDispatch) and the
// in-process ones (autoSetup's launch-notice tests), so the two cannot drift into two different stubs.
// `onRequest` runs before each answer — a test uses it to observe what the CLI had already printed at that moment.
export interface McpStub { url: string; calls: Array<{ method: string; params: unknown }>; close: () => Promise<void> }
export function startMcpStub(
  tools: Array<Record<string, unknown>>,
  callResult: (name: string) => unknown,
  onRequest?: (method: string) => void,
): Promise<McpStub> {
  return new Promise((resolve) => {
    const calls: Array<{ method: string; params: unknown }> = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: unknown }
        calls.push({ method: body.method, params: body.params })
        onRequest?.(body.method)
        let result: unknown = {}
        if (body.method === 'tools/list') result = { tools }
        if (body.method === 'tools/call') {
          const name = (body.params as { name: string }).name
          result = { content: [{ type: 'text', text: JSON.stringify(callResult(name)) }] }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}
