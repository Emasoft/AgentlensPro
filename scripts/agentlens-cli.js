#!/usr/bin/env node
// agentlens-cli — every AgentLens diagnostic tool as a CLI subcommand, over the running
// server's Streamable-HTTP JSON-RPC endpoint. Subcommands, flags, and help are generated
// from the SERVER's own live schemas (tools/list), so the CLI can never go stale and needs
// no local tool registry.
//
// WHY THIS EXISTS (token economy): registering the MCP server in an agent harness injects
// every tool schema into EVERY turn's context (~8k tokens/turn for AgentLens's ~30 tools),
// and any change to that toolset breaks the prompt-cache prefix. Calling the same tools
// through this CLI in a shell command costs zero resident schema tokens, and N calls batch
// into ONE turn. The server still shapes responses lean by default; full payloads belong
// on disk (--out), not in context.
//
//   node scripts/agentlens-cli.js list --desc              # every tool + one-line description
//   node scripts/agentlens-cli.js help get_burn_status     # flags from the live schema
//   node scripts/agentlens-cli.js get_burn_status          # direct subcommand call
//   node scripts/agentlens-cli.js get_cache_break_causes --topN 5 --window 5
//   node scripts/agentlens-cli.js compare_configs --groupBy model --filter '{"window":24}'
//
//   # several tools in ONE invocation; full JSON to files, digests to stdout
//   node scripts/agentlens-cli.js batch \
//     '[{"tool":"get_burn_status"},
//       {"tool":"get_cache_break_causes","args":{"topN":5}}]' --out /tmp/al
//
//   # full (unshaped) payload for a genuine deep drill, straight to a file
//   node scripts/agentlens-cli.js get_cache_break_causes --full --out /tmp/causes.json
//
// Exits non-zero on transport/tool error (fail-fast; no silent fallback).

const http = require('http')
const fs = require('fs')

const ENDPOINT = process.env.AGENTLENS_MCP_URL || 'http://localhost:4316/mcp'

const USAGE = `agentlens-cli — every AgentLens diagnostic tool as a subcommand (schemas come live from the server)

usage:
  agentlens-cli list [--desc]              all tools (names; --desc adds one-line descriptions)
  agentlens-cli help <tool>                a tool's description + flags (from the live schema)
  agentlens-cli <tool> [--param value ...] call a tool (kebab-case or camelCase flags; JSON string for object/array params)
  agentlens-cli call <tool> [json-args]    call with a raw JSON args object
  agentlens-cli batch <json-array>         N calls in one invocation: [{"tool":"...","args":{...}}]

globals: --full (unshaped payload)   --out PATH (full JSON to disk, one-line digest to stdout)
server:  $AGENTLENS_MCP_URL (default http://localhost:4316/mcp)`

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
        } catch {
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
    clientInfo: { name: 'agentlens-cli', version: '2.0.0' },
  })
}

let toolCache = null
async function fetchTools() {
  if (!toolCache) toolCache = (await rpc('tools/list', {})).tools || []
  return toolCache
}

// Tool names use underscores; accept the dashed spelling too (CLI muscle memory).
function resolveTool(tools, name) {
  const norm = name.replace(/-/g, '_').toLowerCase()
  return tools.find(t => t.name.toLowerCase() === norm) || null
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

function firstSentence(s) {
  const one = String(s || '').trim().split('. ')[0]
  return one.length > 140 ? `${one.slice(0, 140)}…` : one
}

// Dispatch-level globals the server's leanify layer reads on EVERY tool, even when the
// tool's own schema doesn't declare them.
const GLOBAL_PARAMS = { verbosity: 'string', maxTokens: 'number' }

function coerce(flag, val, type) {
  if (type === 'number') {
    const n = Number(val)
    if (Number.isNaN(n)) throw new Error(`--${flag} expects a number, got "${val}"`)
    return n
  }
  if (type === 'boolean') {
    if (val === 'true') return true
    if (val === 'false') return false
    throw new Error(`--${flag} expects true|false`)
  }
  if (type === 'object' || type === 'array') {
    try { return JSON.parse(val) } catch { throw new Error(`--${flag} expects a JSON ${type}, got "${val}"`) }
  }
  if (type === 'string') return String(val)
  // Untyped in the schema: best-effort JSON so numbers/objects pass through, else string.
  try { return JSON.parse(val) } catch { return String(val) }
}

function camel(flag) {
  return flag.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

// Map --flags onto the tool's schema properties, coercing each value by its declared type.
// Unknown flags fail fast with the valid list — a typo must never become a silently-ignored
// argument that changes what the diagnostic measures.
function parseToolFlags(rest, schema) {
  const props = (schema && schema.properties) || {}
  const known = new Map(Object.keys(props).map(k => [k.toLowerCase(), k]))
  const args = {}
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) throw new Error(`unexpected argument "${tok}" — params are flags: --name value`)
    const rawName = tok.slice(2)
    const cand = camel(rawName)
    let key = known.get(cand.toLowerCase())
    let type
    if (key) {
      type = props[key] && props[key].type
    } else if (GLOBAL_PARAMS[cand]) {
      key = cand
      type = GLOBAL_PARAMS[cand]
    } else {
      const valid = [...Object.keys(props), ...Object.keys(GLOBAL_PARAMS)].map(k => `--${k}`).join(' ')
      throw new Error(`unknown flag --${rawName}. Valid: ${valid}`)
    }
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) {
      // Bare flag: only meaningful for booleans (--flag ≡ --flag true).
      if (type === 'boolean') { args[key] = true; continue }
      throw new Error(`--${rawName} needs a value`)
    }
    args[key] = coerce(rawName, next, type)
    i++
  }
  return args
}

function renderHelp(t) {
  const props = (t.inputSchema && t.inputSchema.properties) || {}
  const required = new Set((t.inputSchema && t.inputSchema.required) || [])
  const lines = [t.name, '', String(t.description || '').trim(), '']
  const keys = Object.keys(props)
  if (keys.length === 0) {
    lines.push('params: none')
  } else {
    lines.push('params:  (* = required; object/array params take a JSON string)')
    const w = Math.max(...keys.map(k => k.length))
    for (const k of keys) {
      const p = props[k] || {}
      const req = required.has(k) ? '*' : ' '
      lines.push(`  --${k.padEnd(w)}  ${String(p.type || 'any').padEnd(7)}${req} ${firstSentence(p.description)}`)
    }
  }
  lines.push('', 'globals: --full (unshaped payload)   --out PATH (full JSON to disk, digest to stdout)')
  return lines.join('\n')
}

function emit(tool, result, globals) {
  if (globals.out) {
    fs.writeFileSync(globals.out, JSON.stringify(result, null, 2))
    console.log(`${tool}: ${digest(result)}`)
    console.log(`full -> ${globals.out}`)
  } else {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  }
}

async function main() {
  const argv = process.argv.slice(2)
  // Strip the output globals first so every command sees only its own tokens.
  const globals = { full: false, out: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--full') globals.full = true
    else if (argv[i] === '--out') {
      globals.out = argv[++i]
      if (!globals.out) throw new Error('--out needs a path')
    } else rest.push(argv[i])
  }

  const cmd = rest[0]
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE)
    return
  }

  await init()

  if (cmd === 'list') {
    const tools = await fetchTools()
    const withDesc = rest.includes('--desc')
    for (const t of tools) console.log(withDesc ? `${t.name} — ${firstSentence(t.description)}` : t.name)
    return
  }

  if (cmd === 'help') {
    if (!rest[1]) throw new Error('help requires a tool name (agentlens-cli list)')
    const tools = await fetchTools()
    const t = resolveTool(tools, rest[1])
    if (!t) throw new Error(`unknown tool "${rest[1]}" (agentlens-cli list)`)
    console.log(renderHelp(t))
    return
  }

  if (cmd === 'call') {
    const tool = rest[1]
    if (!tool) throw new Error('call requires a tool name')
    const rawArgs = rest[2] && rest[2].startsWith('{') ? JSON.parse(rest[2]) : {}
    emit(tool, await callTool(tool, rawArgs, globals.full), globals)
    return
  }

  if (cmd === 'batch') {
    const spec = JSON.parse(rest[1])
    if (!Array.isArray(spec)) throw new Error('batch requires a JSON array')
    // Sequential on purpose: the endpoint is stateless per request and the server does bounded
    // disk scans; firing them concurrently would multiply the scan cost for no wall-clock win.
    for (const s of spec) {
      const result = await callTool(s.tool, s.args, globals.full || s.full)
      if (globals.out) {
        const p = `${globals.out}-${s.tool}.json`
        fs.writeFileSync(p, JSON.stringify(result, null, 2))
        console.log(`${s.tool}: ${digest(result)}\n  full -> ${p}`)
      } else {
        console.log(`=== ${s.tool} ===\n${typeof result === 'string' ? result : JSON.stringify(result)}`)
      }
    }
    return
  }

  // Anything else is a tool subcommand.
  const tools = await fetchTools()
  const t = resolveTool(tools, cmd)
  if (!t) {
    throw new Error(`unknown command or tool "${cmd}". Tools:\n  ${tools.map(x => x.name).join('\n  ')}`)
  }
  if (rest.slice(1).includes('--help') || rest.slice(1).includes('-h')) {
    console.log(renderHelp(t))
    return
  }
  const args = parseToolFlags(rest.slice(1), t.inputSchema)
  emit(t.name, await callTool(t.name, args, globals.full), globals)
}

main().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1) })
