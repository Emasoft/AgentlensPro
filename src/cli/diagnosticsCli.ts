// src/cli/diagnosticsCli.ts — every AgentlensPro diagnostic tool as a CLI subcommand, over
// the running server's Streamable-HTTP JSON-RPC endpoint (TRDD-7284WCW7; ported from
// scripts/agentlens-cli.js). Subcommands, flags, and help are generated from the SERVER's
// own live schemas (tools/list), so the CLI can never go stale and needs no local registry.
//
// WHY THIS EXISTS (token economy): registering the MCP server in an agent harness injects
// every tool schema into EVERY turn's context (~8k tokens/turn for ~30 tools), and any
// change to that toolset breaks the prompt-cache prefix. Calling the same tools through
// this CLI in a shell command costs zero resident schema tokens, and N calls batch into
// ONE turn. Full payloads belong on disk (--out), not in context.
//
// Exits non-zero on transport/tool error (fail-fast; no silent fallback).

import * as fs from 'fs'
import * as path from 'path'
import {
  apiRequest, callTool, dashboardUrl, dataDir, digest, fetchTools, firstSentence, fmtGb,
  fmtMb, init, mcpEndpoint, parseWhen, resolveTool, sleep, ToolInfo, ToolSchema,
} from './cliCore'
import { installHooks, installOtel, installSkill } from './hookInstall'
import { ensureServer, openDashboard, showStatus, stopServer } from './serverControl'

export const USAGE = `agentlenspro — AI-agent observability: server, dashboard, diagnostics, hooks, setup

usage:
  agentlenspro                                start the server in the foreground (serves the dashboard)
  agentlenspro setup [--dry-run] [--yes]      detect → converge → verify: install or repair everything
                                              (server, DB, hooks, skill, telemetry env), then self-test.
                                              Starts with a read-only environment probe (platform,
                                              Node floor, native deps, port squatters, disk) that
                                              fails fast on real incompatibilities. Platforms:
                                              macOS + Linux; Windows via WSL2 ONLY (native win32 refused)
  agentlenspro server start|stop|restart|status [--supervise]
                                              manage the background server; --supervise runs the
                                              crash-restart supervisor in the foreground
  agentlenspro daemon start|stop|restart|status [--supervise]
                                              the always-on ingestion daemon (same process as the
                                              server); status also shows the hook-spool depth. hooks
                                              auto-revive it, so no log is lost while it is down
  agentlenspro daemon install|uninstall       install/remove a launchd agent (macOS) that keeps the
                                              daemon up 24/7 across logout+reboot (opt-in)
  agentlenspro dashboard                      ensure the server is up, then open the dashboard
  agentlenspro telemetry install|uninstall|status
                                              manage the Claude Code full-telemetry env (verified transaction)
  agentlenspro hook                           lifecycle hook handler (stdin → server; registered by setup)
  agentlenspro gate                           agent-launch burn gate (stdin → server; registered by setup)
  agentlenspro heartbeat-cost [--oneline]     exact token + $ cost of the last settled heartbeat fire
  agentlenspro disable [reason]               GLOBAL BRAKE — turn every AgentlensPro side-effect OFF
                                              (hooks, burn-gate, auto-revive, background ingestion) in
                                              EVERY running Claude session, on its next hook fire. Stops
                                              the server too. Works WITHOUT restarting any session — a
                                              settings edit does not, because a running agent loaded its
                                              config at launch.
  agentlenspro enable                         undo disable — hooks resume on their next fire
  agentlenspro config [list]                  show data-retention knobs: effective value + source
  agentlenspro config get <key>               one retention knob's effective value + where it came from
  agentlenspro config set <key> <value>       persist a retention knob to ~/.agentlens/config.json
                                              (survives uninstall/upgrade; restart to apply; env still wins)
                                              captureRawBodies on|off turns raw-body capture on/off
                                              (opt-in, default off; on mounts a RAM-disk spool on macOS)
  agentlenspro spool ensure                   (re)create the RAM-disk spool for raw-body capture — a
                                              no-op when capture is off; run at login by a LaunchAgent
                                              (installed automatically when capture is turned on)
  agentlenspro env [facet] [--json] [--out F]  detect the runtime environment: terminal kind, OS,
                                              Claude/ai-maestro/CI/container context, filesystem/worktree,
                                              user, network/VPN/proxy, cloud (AWS/Azure/GCP), tooling,
                                              MCP servers. No facet = whole report; --out writes full
                                              JSON to a file (digest to stdout). env list shows facets

diagnostics (schemas come live from the server):
  agentlenspro list [--desc]                  all tools (names; --desc adds one-line descriptions)
  agentlenspro help <tool>                    a tool's description + flags (from the live schema)
  agentlenspro <tool> [--param value ...]     call a tool (kebab-case or camelCase flags; JSON string for object/array params)
  agentlenspro call <tool> [json-args]        call with a raw JSON args object
  agentlenspro batch <json-array>             N calls in one invocation: [{"tool":"...","args":{...}}]

operations:
  --version, -v         print the package version (no side effects)
  --status              server health: pid, uptime, memory, span store, EXACT bytes written,
                        bodies archive — or "not running"
  --start-server        start the standalone server if not already running
                        (alone, or before any tool call: agentlenspro --start-server get_burn_status)
  --stop-server         graceful SIGTERM to the running server (flushes all stores first)
  --dashboard           ensure the server is up, then open the dashboard
  --purge-db            clear the span store + session cards (server re-ingests from logs)
  --export-bodies DIR   extract OTEL bodies into DIR as plain files, from BOTH the content-
                        addressed store and the legacy .wad archive (optionally --since <ISO|hours>
                        / --until <ISO>)
  --purge-bodies        delete archived body volumes PROVEN durable in the store; a volume that
                        fails verification is kept and named (the live 72h window is untouched)
  --risk                one-shot realtime culprit check (~50ms, REST fast path): prints ONLY the
                        active burn risks — each names the culprit session/workspace/model and
                        the magnitude — or "no active burn risks"
  --hooks [k=v ...]     show or flip the hook switches IN REALTIME for every running session
                        (server-side decision point — no restarts): gate=off|warn|enforce|on,
                        capture=on|off (lifecycle event storage), advisor=on|off (in-band
                        PostToolUse warnings). No args = show current config + file path
  --guard [seconds]     realtime burn guard: polls the risk report (default 15s, REST fast path)
                        and prints one [burn-guard] line per risk transition — silent while
                        quiet, culprits named in each line. Arm it in a background monitor
                        BEFORE agent fan-outs.
  --install-skill       (re)install the agentlenspro-diagnostics skill into ~/.claude/skills/
                        from the packaged copy — idempotent (installed / updated / already current)
  --install-hooks       register 'agentlenspro hook' on the LIFECYCLE hook events AND the
                        burn-gate 'agentlenspro gate' (PreToolUse/PostToolUse matched to
                        ^(Task|Agent|Workflow|SendMessage)$ only) — denies the four measured
                        disaster launches with the reason fed back to the agent; fail-open
                        when the server is down; AGENTLENS_GATE=off disables,
                        AGENTLENS_GATE_MODE=warn downgrades denies to warnings. Verified
                        transaction; migrates every previous-generation registration
                        (spy-agentlens*.sh paths, agentlenspro-hook/-gate PATH bins) and
                        removes dead claude-spyglass entries + env.SPYGLASS_DIR. Other tools'
                        hooks on the same events are never touched. Idempotent.
  --uninstall-hooks     remove exactly those agentlens hook entries — every generation
                        (nothing else)
  --install-otel        add the Claude Code telemetry env vars to ~/.claude/settings.json via a
                        verified transaction (atomic write, backup, post-verify, refuses an
                        unparseable file, pre-existing content untouched)
  --uninstall-otel      remove exactly those env vars, restoring any pre-existing values
                        (same transaction guarantees)

examples:  (discover the rest with 'list --desc' then 'help <tool>')
  agentlenspro investigate_burn --windowHours 5      "my 5h window drained — what burned it, WHO?" START HERE
  agentlenspro --risk                                fastest realtime culprit check (~50ms); only ACTIVE risks
  agentlenspro --guard 15                            arm in a bg monitor BEFORE a fan-out; 1 line/risk transition
  agentlenspro get_burn_status                       is anything burning RIGHT NOW across all live sessions?
  agentlenspro get_account_status                    which account/plan/cache-TTL + how much 5h/7d window is left
  agentlenspro get_agent_tokens --agentId abc123     EXACT tokens + $ for ONE sub-agent
  agentlenspro get_cost_rollup --groupBy project --windowHours 5    cost per project over the last 5h
  agentlenspro predict_session_cost --task "xhigh review of auth"   estimate the $ BEFORE you launch
  agentlenspro check_cache_expiry                    has the newest main session's prompt cache gone cold?
  agentlenspro get_conversation --sessionId <id> --turn 7          read one turn of a session verbatim
  agentlenspro batch '[{"tool":"get_burn_status"},{"tool":"get_account_status"}]'   N answers, ONE re-read
  agentlenspro get_cache_break_causes --out breaks.json            full JSON to disk, one-line digest to stdout
  agentlenspro env --json --out env.json             full environment report to a file (attach to a bug report)
  agentlenspro setup --dry-run                       read-only preview of what install/repair would change
  agentlenspro server status       agentlenspro daemon status      agentlenspro dashboard

globals: --full (unshaped payload)   --out PATH (full JSON to disk, digest to stdout)
server:  $AGENTLENS_MCP_URL (default http://localhost:4316/mcp); logs -> ~/.agentlens/server.log`

// ── Realtime risk / guard / hook-switch ops ─────────────────────────────────────────────────

// Realtime risk fetch — the REST fast path (TRDD-9CNHP8CN): one plain GET, no MCP session
// handshake (~10ms vs ~700ms), FULL unshaped risk list. Falls back to the MCP tool once for
// servers predating /api/burn-risk, then stays on whichever path worked.
let riskViaRest = true
interface BurnRiskReport {
  risks?: Array<{ code: string; detail: string; active: boolean }>
  advice?: string
  sources?: { hookEvents?: unknown; bodies?: unknown; burnStatus?: unknown }
}
async function fetchBurnRisk(): Promise<BurnRiskReport> {
  if (riskViaRest) {
    try {
      return await apiRequest('GET', '/api/burn-risk') as BurnRiskReport
    } catch (e) {
      if (!String((e as Error).message).includes('404')) throw e
      riskViaRest = false // older server build — use the MCP tool from now on
    }
  }
  const r = await callTool('check_burn_risk', {}, true)
  return (typeof r === 'string' ? JSON.parse(r) : r) as BurnRiskReport
}

// One-shot realtime culprit check: prints ONLY the active risks (each detail names the
// culprit session/workspace/model + magnitude) — the fastest "who is burning right now".
async function runRisk(): Promise<void> {
  const t0 = Date.now()
  let rep: BurnRiskReport
  try {
    rep = await fetchBurnRisk()
  } catch (e) {
    // The REST path needs no MCP init, so a failure here usually means no server at all.
    throw new Error(`${(e as Error).message} — start it: agentlenspro server start`)
  }
  const active = (rep.risks || []).filter(r => r.active)
  if (active.length === 0) {
    const s = rep.sources || {}
    console.log(`no active burn risks (${Date.now() - t0}ms; feeds: hooks=${!!s.hookEvents} bodies=${!!s.bodies} monitor=${!!s.burnStatus})`)
    return
  }
  for (const r of active) console.log(`[risk] ${r.code}: ${r.detail}`)
  if (rep.advice) console.log(`[advice] ${rep.advice}`)
}

// Realtime hook switches: no args = show; k=v args = set. Applies INSTANTLY to every running
// session machine-wide (the server is the decision point; registrations never change).
async function runHooksConfig(kvs: string[]): Promise<void> {
  interface HookConfig { gateEnabled: boolean; gateMode: string; captureEnabled: boolean; advisorEnabled: boolean }
  if (kvs.length === 0) {
    const r = await apiRequest('GET', '/api/hook-config') as unknown as { config: HookConfig; file: string }
    const c = r.config
    console.log(`gate:     ${c.gateEnabled ? c.gateMode : 'off'}   (gate=off|warn|enforce)`)
    console.log(`capture:  ${c.captureEnabled ? 'on' : 'off'}       (capture=on|off — lifecycle event storage)`)
    console.log(`advisor:  ${c.advisorEnabled ? 'on' : 'off'}       (advisor=on|off — PostToolUse in-band warnings)`)
    console.log(`config file: ${r.file} (changes apply in realtime to ALL sessions)`)
    return
  }
  const patch: Record<string, unknown> = {}
  for (const kv of kvs) {
    const [k, v] = kv.split('=')
    if (k === 'gate') {
      if (v === 'off') patch.gateEnabled = false
      else if (v === 'warn' || v === 'enforce') { patch.gateEnabled = true; patch.gateMode = v }
      else if (v === 'on') patch.gateEnabled = true
      else throw new Error(`gate expects off|warn|enforce|on, got "${v}"`)
    } else if (k === 'capture') {
      if (v !== 'on' && v !== 'off') throw new Error(`capture expects on|off, got "${v}"`)
      patch.captureEnabled = v === 'on'
    } else if (k === 'advisor') {
      if (v !== 'on' && v !== 'off') throw new Error(`advisor expects on|off, got "${v}"`)
      patch.advisorEnabled = v === 'on'
    } else throw new Error(`unknown hook switch "${k}" (gate|capture|advisor)`)
  }
  const r = await apiRequest('POST', '/api/hook-config', patch) as unknown as { config: HookConfig }
  const c = r.config
  console.log(`applied realtime (all sessions): gate=${c.gateEnabled ? c.gateMode : 'off'} capture=${c.captureEnabled ? 'on' : 'off'} advisor=${c.advisorEnabled ? 'on' : 'off'}`)
}

// Realtime burn guard: poll the risk report and print one line per risk TRANSITION —
// fired→'[burn-guard] CODE: detail', cleared→'[burn-guard] CODE cleared'. Silent while
// quiet, so the stdout stream is Monitor-friendly (each line = one notification; no noise).
async function runGuard(intervalSec: number | undefined): Promise<void> {
  const interval = Math.max(5, Math.min(300, intervalSec || 15)) * 1000
  await init()
  console.log(`[burn-guard] armed — polling burn risk every ${interval / 1000}s (silent while quiet)`)
  const wasActive = new Set<string>()
  for (;;) {
    try {
      const rep = await fetchBurnRisk()
      for (const risk of rep.risks || []) {
        if (risk.active && !wasActive.has(risk.code)) {
          console.log(`[burn-guard] ${risk.code}: ${risk.detail}`)
          wasActive.add(risk.code)
        } else if (!risk.active && wasActive.has(risk.code)) {
          console.log(`[burn-guard] ${risk.code} cleared`)
          wasActive.delete(risk.code)
        }
      }
      if (wasActive.size > 0 && rep.advice) {
        // advice rides only on the first line of an episode; suppress repeats
        if (!wasActive.has('__advised')) { console.log(`[burn-guard] advice: ${rep.advice}`); wasActive.add('__advised') }
      } else {
        wasActive.delete('__advised')
      }
    } catch (e) {
      // Server restart mid-watch must not kill the guard — report once per outage.
      if (!wasActive.has('__down')) { console.log(`[burn-guard] server unreachable: ${(e as Error).message}`); wasActive.add('__down') }
    }
    if (wasActive.has('__down')) {
      try { await init(); console.log('[burn-guard] server back — resuming'); wasActive.delete('__down') } catch { /* still down */ }
    }
    await sleep(interval)
  }
}

// ── Tool flag parsing ────────────────────────────────────────────────────────────────────────

// Dispatch-level globals the server's leanify layer reads on EVERY tool, even when the
// tool's own schema doesn't declare them.
const GLOBAL_PARAMS: Record<string, string> = { verbosity: 'string', maxTokens: 'number' }

function coerce(flag: string, val: string, type: string | undefined): unknown {
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

function camel(flag: string): string {
  return flag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// Map --flags onto the tool's schema properties, coercing each value by its declared type.
// Unknown flags fail fast with the valid list — a typo must never become a silently-ignored
// argument that changes what the diagnostic measures.
export function parseToolFlags(rest: string[], schema: ToolSchema | undefined): Record<string, unknown> {
  const props = (schema && schema.properties) || {}
  const known = new Map(Object.keys(props).map(k => [k.toLowerCase(), k]))
  const args: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) throw new Error(`unexpected argument "${tok}" — params are flags: --name value`)
    const rawName = tok.slice(2)
    const cand = camel(rawName)
    let key = known.get(cand.toLowerCase())
    let type: string | undefined
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

function renderHelp(t: ToolInfo): string {
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

function emit(tool: string, result: unknown, globals: { out: string | null }): void {
  if (globals.out) {
    fs.writeFileSync(globals.out, JSON.stringify(result, null, 2))
    console.log(`${tool}: ${digest(result)}`)
    console.log(`full -> ${globals.out}`)
  } else {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  }
}

// ── Main dispatcher ──────────────────────────────────────────────────────────────────────────

export async function runDiagnosticsCli(argv: string[]): Promise<void> {
  // Strip the output globals and ops flags first so every command sees only its own tokens.
  const globals = { full: false, out: null as string | null, startServer: false, dashboard: false }
  interface Ops {
    status: boolean; stop: boolean; purgeDb: boolean; purgeBodies: boolean
    exportBodies: string | null; since?: string; until?: string; installSkill: boolean
    guard?: boolean; guardInterval?: number; risk?: boolean; hooksConfig?: string[]
  }
  const ops: Ops = { status: false, stop: false, purgeDb: false, purgeBodies: false, exportBodies: null, installSkill: false }
  let otelOp: 'install' | 'uninstall' | null = null
  let hooksOp: 'install' | 'uninstall' | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--full') globals.full = true
    else if (argv[i] === '--start-server') globals.startServer = true
    else if (argv[i] === '--dashboard') globals.dashboard = true
    else if (argv[i] === '--status') ops.status = true
    else if (argv[i] === '--stop-server') ops.stop = true
    else if (argv[i] === '--purge-db') ops.purgeDb = true
    else if (argv[i] === '--purge-bodies') ops.purgeBodies = true
    else if (argv[i] === '--export-bodies') {
      ops.exportBodies = argv[++i]
      if (!ops.exportBodies) throw new Error('--export-bodies needs a destination directory')
    } else if (argv[i] === '--since') ops.since = argv[++i]
    else if (argv[i] === '--until') ops.until = argv[++i]
    else if (argv[i] === '--install-skill') ops.installSkill = true
    else if (argv[i] === '--guard') {
      ops.guard = true
      const next = argv[i + 1]
      if (next && /^\d+$/.test(next)) { ops.guardInterval = Number(next); i++ }
    }
    else if (argv[i] === '--risk') ops.risk = true
    else if (argv[i] === '--hooks') {
      ops.hooksConfig = []
      while (argv[i + 1] && /^[a-z]+=/.test(argv[i + 1])) ops.hooksConfig.push(argv[++i])
    }
    else if (argv[i] === '--install-hooks') hooksOp = 'install'
    else if (argv[i] === '--uninstall-hooks') hooksOp = 'uninstall'
    else if (argv[i] === '--install-otel') otelOp = 'install'
    else if (argv[i] === '--uninstall-otel') otelOp = 'uninstall'
    else if (argv[i] === '--out') {
      globals.out = argv[++i]
      if (!globals.out) throw new Error('--out needs a path')
    } else rest.push(argv[i])
  }

  // Settings mutation is standalone — no server needed, exits after the transaction.
  if (otelOp) {
    await installOtel(otelOp === 'uninstall')
    return
  }

  // Skill install is standalone too — pure file copy, no server, no settings mutation.
  if (ops.installSkill) { installSkill(); return }

  // One-shot realtime culprit check — REST fast path, ~50ms end-to-end incl. node boot.
  if (ops.risk) { await runRisk(); return }

  // Hook switches — realtime, machine-wide, no session restarts.
  if (ops.hooksConfig) { await runHooksConfig(ops.hooksConfig); return }

  // Guard mode never returns — it is the long-lived watch loop (arm via a background monitor).
  if (ops.guard) { await runGuard(ops.guardInterval); return }

  // Hook install/uninstall is another settings transaction — no server needed.
  if (hooksOp) {
    await installHooks(hooksOp === 'uninstall')
    return
  }

  if (ops.status) { await showStatus(); return }
  if (ops.stop) { await stopServer(); return }

  if (ops.purgeDb) {
    await apiRequest('POST', '/api/clear')
    console.log('span store + session cards cleared — the server re-ingests from the agent logs')
    return
  }

  if (ops.exportBodies) {
    const destDir = path.resolve(ops.exportBodies)
    const r = await apiRequest('POST', '/api/bodies/export', {
      destDir,
      sinceMs: parseWhen(ops.since, 'since'),
      untilMs: parseWhen(ops.until, 'until'),
    })
    console.log(`exported ${r.files} body file(s), ${fmtMb(Number(r.bytes))} → ${r.destDir}`)
    return
  }

  if (ops.purgeBodies) {
    // Response shape changed with the verify-before-delete gate (TRDD-K3WDPR7M): removed/kept are
    // now per-volume arrays — a volume the store cannot prove is KEPT with its failures named.
    const r = await apiRequest('POST', '/api/bodies/purge')
    const removed = Array.isArray(r.removed) ? r.removed as string[] : []
    const kept = Array.isArray(r.kept) ? r.kept as Array<{ volume: string; verified: number; entries: number }> : []
    console.log(`bodies archive purge: removed ${removed.length} verified volume(s) (${fmtGb(Number(r.freedBytes))} freed), kept ${kept.length} unproven; .idx sidecars + live 72h window untouched`)
    for (const k of kept) console.log(`  KEPT ${k.volume}: only ${k.verified}/${k.entries} lump(s) proven in the store`)
    return
  }

  if (globals.startServer || globals.dashboard) {
    await ensureServer()
    if (globals.dashboard) openDashboard()
    if (rest.length === 0) return // ops-only invocation
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
    if (!rest[1]) throw new Error('help requires a tool name (agentlenspro list)')
    const tools = await fetchTools()
    const t = resolveTool(tools, rest[1])
    if (!t) throw new Error(`unknown tool "${rest[1]}" (agentlenspro list)`)
    console.log(renderHelp(t))
    return
  }

  if (cmd === 'call') {
    const tool = rest[1]
    if (!tool) throw new Error('call requires a tool name')
    const rawArgs = rest[2] && rest[2].startsWith('{') ? JSON.parse(rest[2]) as Record<string, unknown> : {}
    emit(tool, await callTool(tool, rawArgs, globals.full), globals)
    return
  }

  if (cmd === 'batch') {
    const spec = JSON.parse(rest[1]) as Array<{ tool: string; args?: Record<string, unknown>; full?: boolean }>
    if (!Array.isArray(spec)) throw new Error('batch requires a JSON array')
    // Sequential on purpose: the endpoint is stateless per request and the server does bounded
    // disk scans; firing them concurrently would multiply the scan cost for no wall-clock win.
    for (let i = 0; i < spec.length; i++) {
      const s = spec[i]
      const result = await callTool(s.tool, s.args, globals.full || !!s.full)
      if (globals.out) {
        // Position-prefixed so the SAME tool called twice (e.g. two run_diagnostics_sql presets)
        // cannot silently overwrite the earlier result — that exact collision happened in the field.
        const p = `${globals.out}-${i + 1}-${s.tool}.json`
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

// Re-exported so the top-level dispatcher can serve --status quickly and dataDir stays one import away.
export { dataDir, mcpEndpoint, dashboardUrl }
