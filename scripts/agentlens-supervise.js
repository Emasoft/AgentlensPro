#!/usr/bin/env node
/**
 * AgentLens collector supervisor (TRDD-PJC8N1HO spec 1).
 *
 * Keeps `standalone/server.js` alive: on any non-clean exit (a V8 OOM abort exits 134, a signal kill,
 * etc.) it restarts the collector with EXPONENTIAL BACKOFF and appends the crash reason — exit code /
 * signal, uptime, and the tail of the child's stderr — to `~/.agentlens/crash.log`. Before this, the
 * collector died silently and nobody (human or agent) noticed until a later MCP call failed; every OTEL
 * export in the dead window was lost. The supervisor turns a silent death into a ≤ few-second self-heal
 * with an auditable crash record.
 *
 * Usage:  node scripts/agentlens-supervise.js
 * Env:    DATA_DIR (default ~/.agentlens), AGENTLENS_MAX_OLD_SPACE_MB (default 6144),
 *         AGENTLENS_SUPERVISE_MAX_BACKOFF_MS (default 30000).
 * A launchd plist template (scripts/agentlens.plist.template) runs this under KeepAlive on macOS.
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.agentlens')
const CRASH_LOG = path.join(DATA_DIR, 'crash.log')
const MAX_OLD_SPACE = String(Number(process.env.AGENTLENS_MAX_OLD_SPACE_MB) || 6144)
const MAX_BACKOFF_MS = Number(process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS) || 30_000
const HEALTHY_MS = 60_000       // a child that ran this long is "healthy" → reset backoff on its exit
const STDERR_TAIL_BYTES = 8 * 1024

try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* best effort */ }

let backoffMs = 1000
let shuttingDown = false
let child = null

function logCrash(reason) {
  const line = `[${new Date().toISOString()}] ${reason}\n`
  try { fs.appendFileSync(CRASH_LOG, line) } catch { /* best effort */ }
  process.stderr.write(`[supervisor] ${line}`)
}

function start() {
  const started = Date.now()
  // Inherit env so isolated-port / no-telemetry overrides pass through. stdout inherits (logs flow to
  // the launchd/terminal sink); stderr is teed so we can keep its tail for the crash record.
  child = spawn(process.execPath, [`--max-old-space-size=${MAX_OLD_SPACE}`, 'standalone/server.js'],
    { cwd: REPO, env: process.env, stdio: ['ignore', 'inherit', 'pipe'] })

  let stderrTail = Buffer.alloc(0)
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)                                   // keep live stderr visible
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES)  // retain only the tail
  })

  child.on('exit', (code, signal) => {
    const uptimeS = ((Date.now() - started) / 1000).toFixed(1)
    if (shuttingDown) return  // deliberate stop — don't restart
    const tail = stderrTail.toString('utf8').trim().split('\n').slice(-12).join(' | ')
    logCrash(`collector exited code=${code} signal=${signal} uptime=${uptimeS}s — restarting in ${backoffMs}ms. stderr-tail: ${tail || '(none)'}`)
    // A child that ran healthily before dying gets a fresh backoff; a crash-loop backs off geometrically.
    if (Date.now() - started > HEALTHY_MS) backoffMs = 1000
    setTimeout(start, backoffMs)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  })

  child.on('error', (err) => {
    logCrash(`failed to spawn collector: ${err.message} — retrying in ${backoffMs}ms`)
    setTimeout(start, backoffMs)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  })
}

function shutdown(sig) {
  shuttingDown = true
  process.stderr.write(`[supervisor] received ${sig} — stopping collector\n`)
  if (child) { try { child.kill('SIGTERM') } catch { /* ignore */ } }
  // Give the collector a moment to flush (atomic spans/offset save on SIGTERM), then exit.
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.stderr.write(`[supervisor] starting AgentLens collector (max-old-space=${MAX_OLD_SPACE}MB, crash log ${CRASH_LOG})\n`)
start()
