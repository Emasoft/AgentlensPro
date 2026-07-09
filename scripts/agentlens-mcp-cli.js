#!/usr/bin/env node
// agentlens-mcp-cli — call the AgentLens MCP server over its Streamable-HTTP JSON-RPC endpoint.
//
// WHY (token economy): an MCP tool call from an agent costs one API round-trip, which re-reads the
// agent's ENTIRE conversation transcript (~$2 on a 1.2M-token session) before the tool even runs. That
// cost is per-CALL, not per-byte. So N separate MCP calls cost N transcript re-reads.
//
// This CLI collapses N tool calls into ONE shell turn: the agent pays ONE re-read, the full JSON lands
// on DISK (never in context), and only a short summary is printed. Use it whenever you need more than
// one diagnostic answer, or when the full payload is large and you only need a line of it.
//
//   # one tool, summary to stdout (lean by default — the server shapes it)
//   node scripts/agentlens-mcp-cli.js call get_burn_status
//
//   # several tools in ONE turn; full JSON to files, digests to stdout
//   node scripts/agentlens-mcp-cli.js batch \
//     '[{"tool":"get_burn_status"},
//       {"tool":"get_cache_break_causes","args":{"topN":5}}]' --out /tmp/al
//
//   # full (unshaped) payload for a genuine deep drill, straight to a file
//   node scripts/agentlens-mcp-cli.js call get_cache_break_causes --full --out /tmp/causes.json
//
//   node scripts/agentlens-mcp-cli.js list          # tool names only
//
// Exits non-zero on transport/tool error (fail-fast; no silent fallback).

const http = require('http')

const ENDPOINT = process.env.AGENTLENS_MCP_URL || 'http://localhost:4316/mcp'

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  const u = new URL(ENDPOINT)
  const opts = {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Streamable-HTTP transport requires the client to accept BOTH content types.
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => {
        // The transport may answer as SSE ("event: message\ndata: {...}") or as plain JSON.
        const line = raw.split('\n').find(l => l.startsWith('data:'))
        const payload = line ? line.slice(5).trim() : raw
        try {
          const j = JSON.parse(payload)
          if (j.error) return reject(new Error(`${j.error.message || 'rpc error'} (${j.error.code})`))
          resolve(j.result)
        } catch (e) {
          reject(new Error(`bad response (${res.statusCode}): ${raw.slice(0, 300)}`))
        }
      })
    })
    req.on('error', e => reject(new Error(`cannot reach ${ENDPOINT}: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

// The MCP handshake: initialize, then the session is usable on this stateless endpoint.
async function init() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentlens-mcp-cli', version: '1.0.0' },
  })
}

function textOf(result) {
  const c = result && result.content && result.content[0]
  return c && typeof c.text === 'string' ? c.text : JSON.stringify(result)
}

// A one-line digest so the agent's context receives the ANSWER, not the payload.
function digest(obj) {
  if (obj && typeof obj === 'object') {
    if (typeof obj.verdict === 'string') return obj.verdict
    if (typeof obj.text === 'string') return obj.text.split('\n').slice(0, 3).join(' | ')
  }
  const s = JSON.stringify(obj)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

async function callTool(tool, args, full) {
  const a = { ...(args || {}) }
  if (full) a.verbosity = 'full'
  const res = await rpc('tools/call', { name: tool, arguments: a })
  const text = textOf(res)
  try { return JSON.parse(text) } catch { return text }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? argv[outIdx + 1] : null
  const full = argv.includes('--full')
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log('usage: agentlens-mcp-cli.js <list|call <tool> [json-args]|batch <json-array>> [--full] [--out PATH]')
    process.exit(0)
  }

  await init()
  const fs = require('fs')

  if (cmd === 'list') {
    const r = await rpc('tools/list', {})
    console.log(r.tools.map(t => t.name).join('\n'))
    return
  }

  if (cmd === 'call') {
    const tool = argv[1]
    if (!tool) throw new Error('call requires a tool name')
    const rawArgs = argv[2] && argv[2].startsWith('{') ? JSON.parse(argv[2]) : {}
    const result = await callTool(tool, rawArgs, full)
    if (out) {
      fs.writeFileSync(out, JSON.stringify(result, null, 2))
      console.log(`${tool}: ${digest(result)}`)
      console.log(`full -> ${out}`)
    } else {
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    }
    return
  }

  if (cmd === 'batch') {
    const spec = JSON.parse(argv[1])
    if (!Array.isArray(spec)) throw new Error('batch requires a JSON array')
    // Sequential on purpose: the endpoint is stateless per request and the server does bounded disk
    // scans; firing them concurrently would multiply the scan cost for no wall-clock benefit worth it.
    for (const s of spec) {
      const result = await callTool(s.tool, s.args, full || s.full)
      if (out) {
        const p = `${out}-${s.tool}.json`
        fs.writeFileSync(p, JSON.stringify(result, null, 2))
        console.log(`${s.tool}: ${digest(result)}\n  full -> ${p}`)
      } else {
        console.log(`=== ${s.tool} ===\n${typeof result === 'string' ? result : JSON.stringify(result)}`)
      }
    }
    return
  }

  throw new Error(`unknown command: ${cmd}`)
}

main().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1) })
