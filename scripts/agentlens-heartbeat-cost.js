#!/usr/bin/env node
// agentlens-heartbeat-cost — print the EXACT token + $ cost of one janitor heartbeat fire.
//
// Built to be the LAST command a heartbeat runs. It reports the last fire whose API calls have all
// settled — see the hard constraint below — and prints one greppable line plus a breakdown table.
//
//   node scripts/agentlens-heartbeat-cost.js                 # human table + one-line summary
//   node scripts/agentlens-heartbeat-cost.js --oneline       # just the summary line (for a log)
//   node scripts/agentlens-heartbeat-cost.js --json          # raw report
//   node scripts/agentlens-heartbeat-cost.js --fire current  # the in-flight fire (tail excluded)
//   node scripts/agentlens-heartbeat-cost.js --marker '[my-cron]' --window 6 --session 28e3a88d
//
// WHY IT REPORTS THE PREVIOUS FIRE BY DEFAULT (not a choice — a constraint):
// an OTEL request body carries no request_id. The ONLY link from a call to its usage is
//   response(turn i).id  ==  request(turn i+1).diagnostics.previous_message_id
// so a call's tokens are knowable only AFTER the next call is written. A command running inside the
// heartbeat's own turn cannot see that turn's final response. Reporting the in-flight fire would
// under-count its largest output, so we report the last fully-settled fire and disclose the remainder.
// At a 5-minute cadence: fire N prints exactly what fire N-1 cost.
//
// Requires the AgentLens server (it owns the single implementation): AGENTLENS_MCP_URL or :4316.
// Fail-fast: exits non-zero if the server is unreachable or no fire is found. No silent fallback.

const http = require('http')

const ENDPOINT = process.env.AGENTLENS_MCP_URL || 'http://localhost:4316/mcp'

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const u = new URL(ENDPOINT)
  const opts = {
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => {
        const line = raw.split('\n').find(l => l.startsWith('data:'))
        const payload = line ? line.slice(5).trim() : raw
        try {
          const j = JSON.parse(payload)
          if (j.error) return reject(new Error(j.error.message || 'rpc error'))
          resolve(j.result)
        } catch {
          reject(new Error(`bad response (${res.statusCode}): ${raw.slice(0, 200)}`))
        }
      })
    })
    req.on('error', e => reject(new Error(`AgentLens server unreachable at ${ENDPOINT}: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const has = name => process.argv.includes(`--${name}`)
const n = x => Number(x).toLocaleString()

async function main() {
  if (has('help') || has('h')) {
    console.log('usage: agentlens-heartbeat-cost.js [--oneline|--json] [--fire last-complete|current] [--marker M] [--session ID] [--window H]')
    return
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'heartbeat-cost', version: '1.0.0' } })

  const a = { verbosity: 'full', fire: arg('fire', 'last-complete'), window: Number(arg('window', 3)) }
  const marker = arg('marker', null); if (marker) a.marker = marker
  const session = arg('session', null); if (session) a.sessionId = session

  const res = await rpc('tools/call', { name: 'get_heartbeat_cost', arguments: a })
  const text = res && res.content && res.content[0] && res.content[0].text
  const r = JSON.parse(text)

  if (has('json')) { console.log(JSON.stringify(r, null, 2)); return }
  if (!r.fireDetected) { console.error(`FAIL: ${r.verdict}`); process.exit(1) }
  if (has('oneline')) { console.log(r.verdict); return }

  const t = r.tokens, c = r.cost
  console.log(`HEARTBEAT COST — fire ${r.fireStartedAt} (${r.durationSeconds}s, ${r.apiCalls} API calls, ${r.agentSpawns} agent spawns)`)
  console.log(`session ${r.sessionId}`)
  console.log('┏━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━━━━━┓')
  console.log('┃ bucket         ┃       tokens ┃         USD ┃')
  console.log('┡━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━━━━━┩')
  const row = (k, tok, usd) => console.log(`│ ${k.padEnd(14)} │ ${n(tok).padStart(12)} │ ${('$' + usd.toFixed(4)).padStart(11)} │`)
  row('input', t.inputTokens, c.inputUsd)
  row('output', t.outputTokens, c.outputUsd)
  row('cache_read', t.cacheReadTokens, c.cacheReadUsd)
  row('cache_write', t.cacheCreateTokens, c.cacheWriteUsd)
  console.log('└────────────────┴──────────────┴─────────────┘')
  console.log(`TOTAL: ${n(t.totalTokens)} tokens   $${c.totalUsd.toFixed(4)}`)
  console.log(`cache_write tiers: 5m=${n(t.ephemeral5mTokens)}  1h=${n(t.ephemeral1hTokens)}`)
  if (r.byModel.length) console.log('by model: ' + r.byModel.map(m => `${m.model}×${m.calls} $${m.costUsd.toFixed(4)}`).join('  '))
  if (r.callsByToolSurface.length > 1) console.log('tool surfaces (a differing count = a sub-agent stream): ' + r.callsByToolSurface.map(s => `${s.tools}tools×${s.calls}`).join(', '))
  if (r.inFlight) console.log(`\n⚠ ${r.inFlight.calls} unsettled call(s) EXCLUDED. ${r.inFlight.note}`)
  if (r.concurrent.calls) console.log(`\nℹ ${r.concurrent.note}`)
}

main().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1) })
