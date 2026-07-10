#!/usr/bin/env node
// agentlenspro-cli — every AgentlensPro diagnostic tool as a CLI subcommand, over the running
// server's Streamable-HTTP JSON-RPC endpoint. Subcommands, flags, and help are generated
// from the SERVER's own live schemas (tools/list), so the CLI can never go stale and needs
// no local tool registry.
//
// WHY THIS EXISTS (token economy): registering the MCP server in an agent harness injects
// every tool schema into EVERY turn's context (~8k tokens/turn for AgentlensPro's ~30 tools),
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
//   # operations: start the server, open the dashboard, wire Claude Code telemetry
//   agentlenspro-cli --start-server
//   agentlenspro-cli --dashboard
//   agentlenspro-cli --install-otel      # add the OTEL env vars to ~/.claude/settings.json (verified transaction)
//   agentlenspro-cli --uninstall-otel    # remove exactly those vars, everything else untouched
//
// Exits non-zero on transport/tool error (fail-fast; no silent fallback).

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ENDPOINT = process.env.AGENTLENS_MCP_URL || 'http://localhost:4316/mcp'
const DASHBOARD_URL = process.env.AGENTLENS_DASHBOARD_URL || 'http://localhost:3000'
// Overridable ONLY for tests — production always targets the real global settings.
const CLAUDE_SETTINGS = process.env.AGENTLENS_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json')

const USAGE = `agentlenspro-cli — every AgentlensPro diagnostic tool as a subcommand (schemas come live from the server)

usage:
  agentlenspro-cli list [--desc]              all tools (names; --desc adds one-line descriptions)
  agentlenspro-cli help <tool>                a tool's description + flags (from the live schema)
  agentlenspro-cli <tool> [--param value ...] call a tool (kebab-case or camelCase flags; JSON string for object/array params)
  agentlenspro-cli call <tool> [json-args]    call with a raw JSON args object
  agentlenspro-cli batch <json-array>         N calls in one invocation: [{"tool":"...","args":{...}}]

operations:
  --status              server health: pid, uptime, memory, span store, EXACT bytes written,
                        bodies archive — or "not running"
  --start-server        start the AgentlensPro standalone server if not already running
                        (alone, or before any tool call: agentlenspro-cli --start-server get_burn_status)
  --stop-server         graceful SIGTERM to the running server (flushes all stores first)
  --dashboard           ensure the server is up, then open ${DASHBOARD_URL}
  --purge-db            clear the span store + session cards (server re-ingests from logs)
  --export-bodies DIR   extract the archived OTEL bodies into DIR as plain files
                        (optionally --since <ISO|hours> / --until <ISO>)
  --purge-bodies        delete ALL archived body volumes (the live 72h window is untouched)
  --risk                one-shot realtime culprit check (~50ms, REST fast path): prints ONLY the
                        active burn risks — each names the culprit session/workspace/model and
                        the magnitude — or "no active burn risks"
  --hooks [k=v ...]     show or flip the hook switches IN REALTIME for every running session
                        (server-side decision point — no restarts): gate=off|warn|enforce|on,
                        capture=on|off (lifecycle event storage), advisor=on|off (in-band
                        PostToolUse warnings). No args = show current config + file path
  --guard [seconds]     realtime burn guard: polls the risk report (default 15s, REST fast path)
                        and prints one [burn-guard] line per risk transition (fan-out burst,
                        cold-resume risk, compaction rewrite, huge-request burst, burn spike,
                        cache thrash) — silent while quiet, culprits named in each line. Arm it
                        in a background monitor BEFORE agent fan-outs.
  --install-skill       (re)install the agentlenspro-diagnostics skill into ~/.claude/skills/
                        from the repo copy — idempotent (installed / updated / already current)
  --install-hooks       register scripts/spy-agentlens.sh on the 10 LIFECYCLE hook events
                        (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission,
                        Notification, SubagentStart/Stop) AND the burn-gate
                        (scripts/spy-agentlens-gate.sh, PreToolUse/PostToolUse matched to
                        ^(Task|Agent|Workflow|SendMessage)$ only) — it denies the four measured
                        disaster launches (cache thrash, runaway fan-out, cold-resume fan-out,
                        fork storm) with the reason fed back to the agent; SendMessage is gated
                        narrower (deny only on cache-thrash / cold-resume — resuming a dead
                        agent re-runs the request that killed it); fail-open when the
                        server is down; AGENTLENS_GATE=off disables, AGENTLENS_GATE_MODE=warn
                        downgrades denies to warnings. Verified transaction; also removes any
                        dead claude-spyglass hook entries + env.SPYGLASS_DIR. Other tools'
                        hooks on the same events are never touched. Idempotent.
  --uninstall-hooks     remove exactly those spy-agentlens hook entries (nothing else)
  --install-otel        add the Claude Code telemetry env vars to ~/.claude/settings.json via a
                        verified transaction (atomic write, backup, post-verify, refuses an
                        unparseable file, pre-existing content untouched)
  --uninstall-otel      remove exactly those env vars (same transaction guarantees)

globals: --full (unshaped payload)   --out PATH (full JSON to disk, one-line digest to stdout)
server:  $AGENTLENS_MCP_URL (default http://localhost:4316/mcp); logs -> ~/.agentlens/server.log`

// The telemetry wiring AgentlensPro capture depends on. RAW_API_BODIES is computed per-machine.
const OTEL_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
  OTEL_METRIC_EXPORT_INTERVAL: '10000',
  OTEL_LOGS_EXPORT_INTERVAL: '5000',
  OTEL_TRACES_EXPORT_INTERVAL: '1000',
  OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
  OTEL_METRICS_INCLUDE_VERSION: 'true',
  OTEL_METRICS_INCLUDE_ENTRYPOINT: 'true',
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'true',
  OTEL_LOG_USER_PROMPTS: '1',
  OTEL_LOG_ASSISTANT_RESPONSES: '1',
  OTEL_LOG_TOOL_CONTENT: '1',
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_LOG_RAW_API_BODIES: `file:${path.join(os.homedir(), '.agentlens', 'otel-bodies')}`,
}

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
    clientInfo: { name: 'agentlenspro-cli', version: '2.0.0' },
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.agentlens')
const SERVER_LOG = path.join(DATA_DIR, 'server.log')

// Plain HTTP JSON helper for the server's /api/* routes (the MCP transport helpers above are
// JSON-RPC; these are ordinary REST endpoints on the UI port).
function apiRequest(method, apiPath, payload) {
  const base = process.env.AGENTLENS_UI_URL || 'http://localhost:3000'
  const u = new URL(apiPath, base)
  const body = payload === undefined ? null : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(raw)
          if (res.statusCode !== 200) return reject(new Error(j.error || `HTTP ${res.statusCode}`))
          resolve(j)
        } catch { reject(new Error(`bad response (${res.statusCode}): ${raw.slice(0, 200)}`)) }
      })
    })
    req.on('error', e => reject(new Error(`server unreachable at ${base}: ${e.message}`)))
    if (body) req.write(body)
    req.end()
  })
}

/** Start the standalone server if the MCP endpoint is unreachable; wait until it answers. */
async function ensureServer() {
  try { await init(); return } catch { /* not up — start it */ }
  const serverJs = path.resolve(__dirname, '..', 'standalone', 'server.js')
  if (!fs.existsSync(serverJs)) {
    throw new Error(`server bundle missing at ${serverJs} — run \`node esbuild.js\` in the AgentlensPro repo first`)
  }
  // stdout/stderr go to a log file, NOT /dev/null — when the server dies at boot (port conflict,
  // corrupt store) the reason must be readable, or every failure looks like "did not become ready".
  let outFd
  try { outFd = fs.openSync(SERVER_LOG, 'a') } catch { outFd = 'ignore' }
  const child = spawn(process.execPath, ['--max-old-space-size=6144', serverJs], {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
    stdio: ['ignore', outFd, outFd],
  })
  child.unref()
  if (typeof outFd === 'number') fs.closeSync(outFd)
  for (let i = 0; i < 80; i++) { // up to 20s — DB open + first scan can be slow
    await sleep(250)
    try { await init(); console.log(`server started (pid ${child.pid}) — logs: ${SERVER_LOG}`); return } catch { /* keep polling */ }
  }
  throw new Error(`server did not become ready within 20s — check ${SERVER_LOG}`)
}

const fmtGb = b => `${(b / 1024 ** 3).toFixed(2)}GB`
const fmtMb = b => `${(b / 1048576).toFixed(1)}MB`

async function showStatus() {
  let s
  try { s = await apiRequest('GET', '/api/server-stats') } catch (e) {
    // A response (however wrong) means SOMETHING is serving the port — an older build without
    // the stats endpoint, or a foreign process. Only a connection failure means "not running".
    if (!String(e.message).includes('unreachable')) {
      const pid = await findServerPid()
      console.log(`server: RUNNING but does not serve /api/server-stats (older build?)${pid ? ` pid=${pid}` : ''} — restart it: agentlenspro-cli --stop-server && agentlenspro-cli --start-server`)
      return
    }
    console.log(`server: NOT RUNNING (${e.message})`)
    // The pidfile may still name a live process bound to different ports, or be stale.
    try {
      const pid = Number(fs.readFileSync(path.join(DATA_DIR, 'server.pid'), 'utf-8').trim())
      try { process.kill(pid, 0); console.log(`pidfile: ${pid} (process alive — a server may be up on non-default ports)`) }
      catch { console.log(`pidfile: ${pid} (stale — process gone)`) }
    } catch { /* no pidfile */ }
    return
  }
  const up = s.uptimeSec
  const uptime = up >= 3600 ? `${Math.floor(up / 3600)}h${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m${up % 60}s`
  const per = s.persistence
  console.log([
    `server: RUNNING pid=${s.pid} uptime=${uptime} canonical=${s.canonical} (ui:${s.ports.ui} mcp:${s.ports.mcp} otlp:${s.ports.otlp})`,
    `memory: rss=${s.memory.rssMb}MB heap=${s.memory.heapUsedMb}/${s.memory.heapLimitMb}MB`,
    // Segmented store (P4) exposes spans.store/windowMs; a pre-P4 server exposes cap/fileLines/
    // fileBytes instead — render whichever shape arrived, don't crash on the other.
    s.spans.store
      ? `spans:  ${s.spans.inMemory} in memory (${Math.round(s.spans.windowMs / 60000)}m window), ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.store.totalBytes)} (${s.spans.store.totalSpans} spans / ${s.spans.store.segments} segment(s), retention ${s.spans.retentionDays}d) | log sessions: ${s.logSessions}`
      : `spans:  ${s.spans.inMemory}/${s.spans.cap} in memory, ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.fileBytes)} (${s.spans.fileLines} lines) | log sessions: ${s.logSessions}`,
    `disk writes since boot: ${fmtMb(per.totalBytesWritten)} total — spans ${fmtMb(per.spanAppendBytes)} in ${per.spanAppendWrites} appends${per.spanCompactions !== undefined ? ` + ${per.spanCompactions} compaction(s) ${fmtMb(per.spanCompactBytes)}` : ''}; offsets ${fmtMb(per.offsetsBytes)}×${per.offsetsWrites}; cards ${fmtMb(per.cardsBytes)}×${per.cardsWrites}`,
    `bodies: archive ${s.bodies.archive.volumes} volume(s), ${s.bodies.archive.entries} lumps, ${fmtGb(s.bodies.archive.bytes)}; last pass archived ${s.bodies.lastPass.removedFiles} (live kept ${fmtGb(s.bodies.lastPass.keptBytes)})`,
    // hookEvents/gate are absent when --status hits a server built before TRDD-Q6ZOUVK5/GOD0108C — skip, don't crash.
    ...(s.hookEvents ? [`hooks:  ${s.hookEvents.receivedSinceBoot} event(s) since boot, ${s.hookEvents.files} bucket(s) ${fmtMb(s.hookEvents.bytes)} on disk`] : []),
    ...(s.gate ? [`gate:   mode=${s.gate.mode} — ${s.gate.checks} check(s), ${s.gate.denies} deny, ${s.gate.warns} warn, ${s.gate.advisories} advisories since boot`] : []),
    `data:   ${s.dataDir} (spans ${fmtMb(per.files.spans)}, cards ${fmtMb(per.files.cards)}, offsets ${fmtMb(per.files.offsets)})`,
  ].join('\n'))
}

/** The server's PID, through a fallback chain that also covers builds predating /api/server-stats:
 *  stats endpoint → pidfile → lsof on the MCP port. Returns null when nothing is running. */
async function findServerPid() {
  try { return (await apiRequest('GET', '/api/server-stats')).pid } catch { /* older build or down */ }
  // Is anything answering MCP at all? If not, the server is genuinely down.
  try { await init() } catch { return null }
  try {
    const pid = Number(fs.readFileSync(path.join(DATA_DIR, 'server.pid'), 'utf-8').trim())
    if (pid > 0) { process.kill(pid, 0); return pid }
  } catch { /* no/stale pidfile (pre-pidfile build) — fall through to lsof */ }
  const port = new URL(ENDPOINT).port
  for (const lsof of ['lsof', '/usr/sbin/lsof']) { // /usr/sbin is often absent from a child PATH
    try {
      const out = require('child_process').execFileSync(lsof, ['-ti', `:${port}`], { encoding: 'utf8' })
      const pid = Number(out.split('\n').find(Boolean))
      if (pid > 0) return pid
    } catch { /* try the next candidate */ }
  }
  return null
}

async function stopServer() {
  const pid = await findServerPid()
  if (pid === null) {
    console.log('server already stopped')
    return
  }
  process.kill(pid, 'SIGTERM') // graceful — the server flushes every store on SIGTERM
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try { await init() } catch { console.log(`server stopped (pid ${pid})`); return }
  }
  throw new Error(`server (pid ${pid}) did not stop within 10s — inspect it before escalating to SIGKILL`)
}

function parseWhen(v, flag) {
  if (v === undefined) return undefined
  if (/^\d+(\.\d+)?$/.test(v)) return Date.now() - Number(v) * 3600e3 // bare number = hours ago
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new Error(`--${flag} expects an ISO date or a number of hours, got "${v}"`)
  return t
}

function openDashboard() {
  if (process.platform === 'darwin') {
    spawn('open', [DASHBOARD_URL], { detached: true, stdio: 'ignore' }).unref()
    console.log(`dashboard -> ${DASHBOARD_URL}`)
  } else {
    console.log(`open ${DASHBOARD_URL} in your browser`)
  }
}

/** Mutate ~/.claude/settings.json ONLY through the verified transaction engine
 *  (scripts/safe_config_edit.py: refuse-unparseable, atomic backup+rename, cross-process
 *  lock, post-apply verify). A direct fs.writeFile of a user config file once wiped a
 *  user's whole settings.json — never reintroduce that path. */
function runSafeConfigEdit(ops, createIfMissing) {
  const script = path.resolve(__dirname, 'safe_config_edit.py')
  if (!fs.existsSync(script)) throw new Error(`safe_config_edit.py missing at ${script}`)
  const args = [script, '--file', CLAUDE_SETTINGS, '--format', 'json']
  if (createIfMissing) args.push('--create-if-missing')
  return new Promise((resolve, reject) => {
    // Windows-safe: most Windows Pythons expose `python`/`py`, not `python3` (audit blocker #1).
    const pyCandidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
    const py = pyCandidates.find(b => { try { execFileSync(b, ['--version'], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false } }) || pyCandidates[0]
    const child = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(out))
      else reject(new Error(`safe_config_edit failed (exit ${code}): ${(err || out).trim().slice(0, 300)}`))
    })
    child.stdin.write(JSON.stringify({ ops }))
    child.stdin.end()
  })
}

async function installOtel(uninstall) {
  const keys = Object.keys(OTEL_ENV)
  const ops = uninstall
    ? keys.map(k => ({ op: 'delete', path: ['env', k] }))
    : keys.map(k => ({ op: 'set', path: ['env', k], value: OTEL_ENV[k] }))
  const result = await runSafeConfigEdit(ops, !uninstall)
  const verb = uninstall ? 'removed from' : 'installed into'
  console.log(`${keys.length} telemetry env var(s) ${verb} ${CLAUDE_SETTINGS}`)
  console.log(`changed=${result.changed}${result.backupPath ? ` backup=${result.backupPath}` : ''} attempts=${result.attempts}`)
  if (!uninstall) console.log('restart Claude Code sessions to pick up the env change')
}

// Lifecycle events worth hooking — they carry signals the JSONL transcripts and OTEL bodies
// LACK (exact rate-limit turn deaths, compaction boundaries + trigger, session lifecycle).
// Deliberately NO unmatched PreToolUse/PostToolUse/UserPromptSubmit: those are fully redundant
// with the existing ingestion and are the only high-frequency hooks — all of the per-turn
// overhead that made claude-spyglass expensive lived there (2+ process spawns per tool call).
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop',
]

// The burn gate (TRDD-GOD0108C) is the ONE narrow exception to the no-PreToolUse rule: it is
// MATCHED to agent-launch tools only (rare calls, the exact moments token disasters start), it
// is a single curl to the resident server (no node spawn, no client-side parsing), and it must
// be SYNC (async hooks cannot deny) with a hard 3s timeout so a dead server never stalls a turn.
// SendMessage joined the matcher in P6: resuming a DEAD agent re-runs the request that killed
// it, so the server gates it — but ONLY on cache-thrash / cold-resume (evaluateSendMessageGate);
// routine messaging is never denied.
const GATE_MATCHER = '^(Task|Agent|Workflow|SendMessage)$'
const GATE_EVENTS = ['PreToolUse', 'PostToolUse']

// Install (or remove) the spy-agentlens.sh forwarder on the lifecycle events, via the same
// verified transaction as --install-otel. Install ALSO removes every claude-spyglass hook entry
// and its env.SPYGLASS_DIR (the "replace spyglass" migration) — spyglass's server is gone, so
// its 28 registrations were dead process spawns on every event. Merge-preserving: hooks from
// other tools (janitor etc.) on the same events are never touched.
// Rebuild one event's matcher list: strip spy-agentlens entries (and, when installing,
// spyglass entries too), drop matchers left empty, append our entry on lifecycle events and
// the gate entry on agent-launch tool events. Pure — returns the new list + what was
// stripped; the caller decides whether anything changed.
function rebuildEventMatchers(matchers, ev, uninstall, cmd, gateCmd) {
  // 'spy-agentlens' (no .sh suffix) covers BOTH scripts — spy-agentlens.sh AND
  // spy-agentlens-gate.sh — so uninstall can never orphan a gate entry.
  const isOurs = h => typeof (h && h.command) === 'string' && h.command.includes('spy-agentlens')
  const isSpyglass = h => typeof (h && h.command) === 'string' && h.command.includes('spyglass-collect.sh')
  const out = { rebuilt: [], removedOurs: 0, removedSpyglass: 0, installed: false }
  for (const m of matchers) {
    const kept = (Array.isArray(m.hooks) ? m.hooks : []).filter(h => {
      if (isOurs(h)) { out.removedOurs++; return false }
      if (!uninstall && isSpyglass(h)) { out.removedSpyglass++; return false }
      return true
    })
    if (kept.length > 0) out.rebuilt.push({ ...m, hooks: kept }) // a matcher left empty is dropped
  }
  if (!uninstall && HOOK_EVENTS.includes(ev)) {
    out.rebuilt.push({ hooks: [{ type: 'command', command: cmd, timeout: 2, async: true }] })
    out.installed = true
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    // SYNC (no async:true — an async hook cannot deny) + matched to agent-launch tools only.
    out.rebuilt.push({ matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCmd, timeout: 3 }] })
    out.installed = true
  }
  return out
}

async function installHooks(uninstall) {
  // Native Windows has no bash: register the node twins there (audit blocker #2). POSIX
  // (incl. WSL) keeps bash+curl — no node boot on the hook path. Both name families contain
  // 'spy-agentlens', so isOurs strips either kind on reinstall/uninstall from any platform.
  const win = process.platform === 'win32'
  const script = path.resolve(__dirname, win ? 'spy-agentlens.mjs' : 'spy-agentlens.sh')
  const gateScript = path.resolve(__dirname, win ? 'spy-agentlens-gate.mjs' : 'spy-agentlens-gate.sh')
  if (!uninstall && !fs.existsSync(script)) throw new Error(`hook script missing at ${script} — is the repo checkout intact?`)
  if (!uninstall && !fs.existsSync(gateScript)) throw new Error(`gate script missing at ${gateScript} — is the repo checkout intact?`)
  const runner = win ? 'node' : 'bash'
  const cmd = `${runner} ${script}`
  const gateCmd = `${runner} ${gateScript}`

  let settings = {}
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    // Refuse-unparseable, same stance as safe_config_edit: never "start fresh" over user config.
    try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) }
    catch { throw new Error(`refusing: ${CLAUDE_SETTINGS} is not parseable JSON — fix it before editing hooks`) }
  }
  const hooks = (settings && typeof settings === 'object' && settings.hooks) || {}

  const ops = []
  let removedSpyglass = 0
  let removedOurs = 0
  let added = 0
  const events = new Set([...Object.keys(hooks), ...(uninstall ? [] : [...HOOK_EVENTS, ...GATE_EVENTS])])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, uninstall, cmd, gateCmd)
    // Counters reflect only events that actually change — an already-current event (ours
    // present, nothing stripped) must not inflate "installed on N events" to a lie.
    if (JSON.stringify(r.rebuilt) === JSON.stringify(matchers)) continue
    removedOurs += r.removedOurs
    removedSpyglass += r.removedSpyglass
    if (r.installed) added++
    if (r.rebuilt.length === 0) ops.push({ op: 'delete', path: ['hooks', ev] })
    else ops.push({ op: 'set', path: ['hooks', ev], value: r.rebuilt })
  }
  // env.SPYGLASS_DIR only feeds the spyglass hook commands — dead once those are removed.
  if (!uninstall && settings.env && settings.env.SPYGLASS_DIR !== undefined) {
    ops.push({ op: 'delete', path: ['env', 'SPYGLASS_DIR'] })
  }

  if (ops.length === 0) {
    console.log(uninstall ? 'no agentlens hooks present — nothing to remove' : 'hooks already installed — nothing to change')
    return
  }
  const result = await runSafeConfigEdit(ops, !uninstall)
  if (uninstall) {
    console.log(`removed ${removedOurs} agentlens hook entr${removedOurs === 1 ? 'y' : 'ies'} from ${CLAUDE_SETTINGS}`)
  } else {
    console.log(`installed spy-agentlens hooks on ${added} event(s) in ${CLAUDE_SETTINGS} (lifecycle forwarder + burn-gate on ${GATE_MATCHER})`)
    if (removedSpyglass > 0) console.log(`removed ${removedSpyglass} dead claude-spyglass hook entr${removedSpyglass === 1 ? 'y' : 'ies'} (+ env.SPYGLASS_DIR)`)
    if (removedOurs > 0) console.log(`refreshed ${removedOurs} pre-existing agentlens entr${removedOurs === 1 ? 'y' : 'ies'}`)
  }
  console.log(`changed=${result.changed}${result.backupPath ? ` backup=${result.backupPath}` : ''} attempts=${result.attempts}`)
  console.log('restart Claude Code sessions to pick up the hook change')
}

// (Re)install the agentlenspro-diagnostics skill into the user scope. The repo copy is the
// single source of truth (skills/agentlenspro-diagnostics/SKILL.md); ~/.claude/skills/ is a
// managed installation target. Idempotent by content comparison — safe to run on every
// install / update, and the way to recover the skill if it was deleted.
function installSkill() {
  // __dirname resolves through the global npm-link symlink to the REAL repo scripts/ dir
  // (node realpaths the main module), so this works from any cwd.
  const src = path.resolve(__dirname, '..', 'skills', 'agentlenspro-diagnostics', 'SKILL.md')
  if (!fs.existsSync(src)) throw new Error(`skill source missing at ${src} — is the repo checkout intact?`)
  const dst = path.join(os.homedir(), '.claude', 'skills', 'agentlenspro-diagnostics', 'SKILL.md')
  const content = fs.readFileSync(src, 'utf8')
  const existed = fs.existsSync(dst)
  if (existed && fs.readFileSync(dst, 'utf8') === content) {
    console.log(`skill agentlenspro-diagnostics: already current (${dst})`)
    return
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, content)
  console.log(`skill agentlenspro-diagnostics: ${existed ? 'updated' : 'installed'} -> ${dst}`)
}

// Realtime risk fetch — the REST fast path (TRDD-9CNHP8CN): one plain GET, no MCP session
// handshake (~10ms vs ~700ms), FULL unshaped risk list. Falls back to the MCP tool once for
// servers predating /api/burn-risk, then stays on whichever path worked.
let riskViaRest = true
async function fetchBurnRisk() {
  if (riskViaRest) {
    try {
      return await apiRequest('GET', '/api/burn-risk')
    } catch (e) {
      if (!String(e.message).includes('404')) throw e
      riskViaRest = false // older server build — use the MCP tool from now on
    }
  }
  const r = await callTool('check_burn_risk', {}, true)
  return typeof r === 'string' ? JSON.parse(r) : r
}

// Realtime hook switches: no args = show; k=v args = set. Applies INSTANTLY to every running
// session machine-wide (the server is the decision point; registrations never change).
async function runHooksConfig(kvs) {
  if (kvs.length === 0) {
    const r = await apiRequest('GET', '/api/hook-config')
    const c = r.config
    console.log(`gate:     ${c.gateEnabled ? c.gateMode : 'off'}   (gate=off|warn|enforce)`)
    console.log(`capture:  ${c.captureEnabled ? 'on' : 'off'}       (capture=on|off — lifecycle event storage)`)
    console.log(`advisor:  ${c.advisorEnabled ? 'on' : 'off'}       (advisor=on|off — PostToolUse in-band warnings)`)
    console.log(`config file: ${r.file} (changes apply in realtime to ALL sessions)`)
    return
  }
  const patch = {}
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
  const r = await apiRequest('POST', '/api/hook-config', patch)
  const c = r.config
  console.log(`applied realtime (all sessions): gate=${c.gateEnabled ? c.gateMode : 'off'} capture=${c.captureEnabled ? 'on' : 'off'} advisor=${c.advisorEnabled ? 'on' : 'off'}`)
}

// One-shot realtime culprit check: prints ONLY the active risks (each detail names the
// culprit session/workspace/model + magnitude) — the fastest "who is burning right now".
async function runRisk() {
  const t0 = Date.now()
  let rep
  try {
    rep = await fetchBurnRisk()
  } catch (e) {
    // The REST path needs no MCP init, so a failure here usually means no server at all.
    console.error(`FAIL: ${e.message} — start it: agentlenspro-cli --start-server`)
    process.exit(1)
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

// Realtime burn guard: poll the risk report and print one line per risk TRANSITION —
// fired→'[burn-guard] CODE: detail', cleared→'[burn-guard] CODE cleared'. Silent while
// quiet, so the stdout stream is Monitor-friendly (each line = one notification; no noise).
async function runGuard(intervalSec) {
  const interval = Math.max(5, Math.min(300, intervalSec || 15)) * 1000
  await init()
  console.log(`[burn-guard] armed — polling burn risk every ${interval / 1000}s (silent while quiet)`)
  const wasActive = new Set()
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
      if (!wasActive.has('__down')) { console.log(`[burn-guard] server unreachable: ${e.message}`); wasActive.add('__down') }
    }
    if (wasActive.has('__down')) {
      try { await init(); console.log('[burn-guard] server back — resuming'); wasActive.delete('__down') } catch { /* still down */ }
    }
    await new Promise(r => setTimeout(r, interval))
  }
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
  // Strip the output globals and ops flags first so every command sees only its own tokens.
  const globals = { full: false, out: null, startServer: false, dashboard: false }
  const ops = { status: false, stop: false, purgeDb: false, purgeBodies: false, exportBodies: null, since: undefined, until: undefined, installSkill: false }
  let otelOp = null
  let hooksOp = null
  const rest = []
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
    const r = await apiRequest('POST', '/api/clear')
    console.log('span store + session cards cleared — the server re-ingests from the agent logs')
    void r
    return
  }

  if (ops.exportBodies) {
    const destDir = path.resolve(ops.exportBodies)
    const r = await apiRequest('POST', '/api/bodies/export', {
      destDir,
      sinceMs: parseWhen(ops.since, 'since'),
      untilMs: parseWhen(ops.until, 'until'),
    })
    console.log(`exported ${r.files} body file(s), ${fmtMb(r.bytes)} → ${r.destDir}`)
    return
  }

  if (ops.purgeBodies) {
    const r = await apiRequest('POST', '/api/bodies/purge')
    console.log(`bodies archive purged: ${r.lumps} lump(s), ${fmtGb(r.freedBytes)} freed (live 72h window untouched)`)
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
    if (!rest[1]) throw new Error('help requires a tool name (agentlenspro-cli list)')
    const tools = await fetchTools()
    const t = resolveTool(tools, rest[1])
    if (!t) throw new Error(`unknown tool "${rest[1]}" (agentlenspro-cli list)`)
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
    for (let i = 0; i < spec.length; i++) {
      const s = spec[i]
      const result = await callTool(s.tool, s.args, globals.full || s.full)
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

// Only auto-run the CLI when this file is the process entry point. When it is `require`d
// (the cliMatchers integration test imports rebuildEventMatchers), the guard keeps main()
// from starting the whole CLI — but the global `agentlenspro-cli` binary still runs normally.
if (require.main === module) {
  main().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1) })
}

// Pure hook-matcher internals exercised by src/test/cliMatchers.test.ts (no server needed).
module.exports = { rebuildEventMatchers, GATE_MATCHER, GATE_EVENTS }
