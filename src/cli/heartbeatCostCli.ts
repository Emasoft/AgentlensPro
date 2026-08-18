// src/cli/heartbeatCostCli.ts — `agentlenspro heartbeat-cost` (TRDD-7284WCW7). Absorbs
// scripts/agentlens-heartbeat-cost.js: print the EXACT token + $ cost of one janitor
// heartbeat fire. Built to be the LAST command a heartbeat runs.
//
// WHY IT REPORTS THE PREVIOUS FIRE BY DEFAULT (not a choice — a constraint): an OTEL request
// body carries no request_id. The ONLY link from a call to its usage is
//   response(turn i).id == request(turn i+1).diagnostics.previous_message_id
// so a call's tokens are knowable only AFTER the next call is written. A command running
// inside the heartbeat's own turn cannot see that turn's final response. Reporting the
// in-flight fire would under-count its largest output, so we report the last fully-settled
// fire and disclose the remainder. At a 5-minute cadence: fire N prints exactly what fire
// N-1 cost.
//
// Requires the AgentlensPro server (it owns the single implementation): AGENTLENS_MCP_URL
// or :4316. Fail-fast: throws (→ exit non-zero) if the server is unreachable or no fire is
// found. No silent fallback.

import { init, rpc, textOf } from './cliCore'
import { assertKnownFlags } from './argHelpers'

const KNOWN_FLAGS = new Set(['--oneline', '--json', '--fire', '--marker', '--session', '--window', '--help', '-h'])
const VALUED_FLAGS = new Set(['--fire', '--marker', '--session', '--window'])

function arg(argv: string[], name: string, dflt: string | null): string | null {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

interface HeartbeatReport {
  fireDetected: boolean
  verdict: string
  fireStartedAt: string
  durationSeconds: number
  apiCalls: number
  agentSpawns: number
  sessionId: string
  tokens: {
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number
    totalTokens: number; ephemeral5mTokens: number; ephemeral1hTokens: number
  }
  cost: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number; totalUsd: number }
  byModel: Array<{ model: string; calls: number; costUsd: number }>
  callsByToolSurface: Array<{ tools: number; calls: number }>
  inFlight?: { calls: number; note: string }
  concurrent: { calls: number; note: string }
}

export async function runHeartbeatCost(argv: string[]): Promise<void> {
  const has = (name: string): boolean => argv.includes(`--${name}`)
  const n = (x: number): string => Number(x).toLocaleString()

  if (has('help') || has('h')) {
    console.log('usage: agentlenspro heartbeat-cost [--oneline|--json] [--fire last-complete|current] [--marker M] [--session ID] [--window H]')
    return
  }
  // A typo'd flag used to be silently ignored and exit 0 (TRDD-PIB6T4RU).
  assertKnownFlags(argv, KNOWN_FLAGS, VALUED_FLAGS, 'agentlenspro heartbeat-cost --help')
  await init()

  const a: Record<string, unknown> = {
    verbosity: 'full',
    fire: arg(argv, 'fire', 'last-complete'),
    window: Number(arg(argv, 'window', '3')),
  }
  const marker = arg(argv, 'marker', null); if (marker) a.marker = marker
  const session = arg(argv, 'session', null); if (session) a.sessionId = session

  const res = await rpc('tools/call', { name: 'get_heartbeat_cost', arguments: a })
  const r = JSON.parse(textOf(res)) as HeartbeatReport

  if (has('json')) { console.log(JSON.stringify(r, null, 2)); return }
  if (!r.fireDetected) throw new Error(r.verdict)
  if (has('oneline')) { console.log(r.verdict); return }

  const t = r.tokens, c = r.cost
  console.log(`HEARTBEAT COST — fire ${r.fireStartedAt} (${r.durationSeconds}s, ${r.apiCalls} API calls, ${r.agentSpawns} agent spawns)`)
  console.log(`session ${r.sessionId}`)
  console.log('┏━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━━━━━┓')
  console.log('┃ bucket         ┃       tokens ┃         USD ┃')
  console.log('┡━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━━━━━┩')
  const row = (k: string, tok: number, usd: number): void => {
    console.log(`│ ${k.padEnd(14)} │ ${n(tok).padStart(12)} │ ${('$' + usd.toFixed(4)).padStart(11)} │`)
  }
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
