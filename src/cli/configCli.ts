// src/cli/configCli.ts — `agentlenspro config` (TRDD-ZAV74M8Q): inspect and persist the data
// retention knobs. Reads/writes DATA_DIR/config.json directly (no server round-trip) so it works
// whether or not the server/daemon is running, and the values it writes survive an uninstall/upgrade
// like the data they govern. The effective value obeys the same precedence the server resolves at
// boot: env var > config.json > built-in default. See src/retentionConfig.ts.

import { dataDir } from './cliCore'
import {
  RETENTION_META, configPath, findMeta, loadRetentionConfig, resolveKnobWithSource, setRetentionKey,
  type RetentionKeyMeta,
} from '../retentionConfig'
import { RAW_BODIES_ENV, RAW_BODIES_KEY, rawBodyCaptureWithSource, setRawBodyCapture } from '../captureConfig'
import { ensureTelemetryConfig } from '../telemetryConfig'

/** The one non-numeric knob (TRDD-BKF5NZD3): raw-body capture is a boolean, and it is OFF by default
 *  because turning it on costs ~35 GB/day of SSD writes. Special-cased rather than forced into the
 *  numeric RETENTION_META table — a boolean with a min/unit/floor would be a lie. */
const CAPTURE_KEY = 'captureRawBodies'
const CAPTURE_DESC = 'let Claude Code dump every raw API body to disk (~35 GB/day — off unless you need it)'

function parseOnOff(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false
  return undefined
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}

/** `agentlenspro config` / `config list` — every knob's effective value, unit, source, and meaning. */
function listConfig(dir: string): void {
  const file = loadRetentionConfig(dir)
  const cap = rawBodyCaptureWithSource(dir, process.env)
  const rows = [
    ...RETENTION_META.map((m) => {
      const { value, source } = resolveKnobWithSource(m, file, process.env)
      return { key: m.key as string, value: String(value), unit: m.unit, source: source as string, desc: m.desc, env: m.env }
    }),
    { key: CAPTURE_KEY, value: cap.enabled ? 'on' : 'off', unit: 'bool', source: cap.source as string, desc: CAPTURE_DESC, env: RAW_BODIES_ENV },
  ]
  const wKey = Math.max(3, ...rows.map((r) => r.key.length))
  const wVal = Math.max(5, ...rows.map((r) => r.value.length))
  const wUnit = Math.max(4, ...rows.map((r) => r.unit.length))
  const wSrc = Math.max(6, ...rows.map((r) => r.source.length))

  console.log(`data retention — precedence: env var > ${configPath(dir)} > built-in default\n`)
  console.log(`  ${pad('KEY', wKey)}  ${pad('VALUE', wVal)}  ${pad('UNIT', wUnit)}  ${pad('SOURCE', wSrc)}  WHAT`)
  for (const r of rows) {
    console.log(`  ${pad(r.key, wKey)}  ${pad(r.value, wVal)}  ${pad(r.unit, wUnit)}  ${pad(r.source, wSrc)}  ${r.desc}`)
  }
  console.log(`\nset a value:   agentlenspro config set <key> <value>   (restart the server/daemon to apply)`)
  console.log(`ops override:  export <ENV>=<value>  — env always wins over the file, e.g. ${rows[0].env}=${rows[0].value}`)
}

/** `agentlenspro config get <key>` — one knob's effective value + where it came from. */
function getConfig(dir: string, key: string): number {
  if (key === CAPTURE_KEY) {
    const { enabled, source } = rawBodyCaptureWithSource(dir, process.env)
    console.log(`${CAPTURE_KEY} = ${enabled ? 'on' : 'off'}  (source: ${source}; env ${RAW_BODIES_ENV}; default off)`)
    console.log(CAPTURE_DESC)
    return 0
  }
  const m = findMeta(key)
  if (!m) {
    console.error(`unknown retention key: ${key}\nvalid keys: ${RETENTION_META.map((x) => x.key).join(', ')}`)
    return 1
  }
  const { value, source } = resolveKnobWithSource(m, loadRetentionConfig(dir), process.env)
  console.log(`${m.key} = ${value} ${m.unit}  (source: ${source}; env ${m.env}; default ${m.def}; min ${m.min})`)
  console.log(m.desc)
  return 0
}

/** `agentlenspro config set <key> <value>` — validate and persist to config.json (atomic, non-destructive). */
async function setConfig(dir: string, key: string, rawValue: string): Promise<number> {
  if (key === CAPTURE_KEY) {
    const enabled = parseOnOff(rawValue)
    if (enabled === undefined) {
      console.error(`value must be on|off, got: ${JSON.stringify(rawValue)}`)
      return 1
    }
    setRawBodyCapture(dir, enabled)
    // Apply to settings.json NOW rather than waiting for a server restart: with capture turned OFF
    // the whole point is to stop the bleeding immediately, and a user who has to remember a second
    // command to make the setting real does not have a working off switch.
    const r = await ensureTelemetryConfig({ dataDir: dir, captureRawBodies: enabled })
    console.log(`set ${CAPTURE_KEY} = ${enabled ? 'on' : 'off'} in ${configPath(dir)}`)
    if (r.removed.includes(RAW_BODIES_KEY)) console.log(`removed ${RAW_BODIES_KEY} from ${r.settingsPath}`)
    else if (r.added.includes(RAW_BODIES_KEY) || enabled) console.log(`wired ${RAW_BODIES_KEY} → file:${r.bodiesDir}`)
    // Claude Code reads its env block at LAUNCH, so a settings edit reaches only FUTURE sessions —
    // this is exactly why 13 already-running sessions kept writing through the first fix.
    console.log('restart your Claude Code sessions for this to take effect (env is read at launch).')
    return 0
  }
  const m: RetentionKeyMeta | undefined = findMeta(key)
  if (!m) {
    console.error(`unknown config key: ${key}\nvalid keys: ${[...RETENTION_META.map((x) => x.key), CAPTURE_KEY].join(', ')}`)
    return 1
  }
  const value = Number(rawValue)
  if (rawValue.trim() === '' || !Number.isFinite(value)) {
    console.error(`value must be a number, got: ${JSON.stringify(rawValue)}`)
    return 1
  }
  // setRetentionKey enforces the min floor and THROWS on a corrupt existing file rather than
  // clobbering it — surface that as a fail-fast CLI error, never a silent reset.
  setRetentionKey(dir, m.key, value)
  console.log(`set ${m.key} = ${value} ${m.unit} in ${configPath(dir)}`)
  console.log(`restart the server/daemon to apply:  agentlenspro server restart`)
  return 0
}

/** Entry for `agentlenspro config [...]`. Returns the process exit code (fail-fast, non-zero on error). */
export async function runConfigCli(argv: string[]): Promise<number> {
  const dir = dataDir()
  const sub = argv[0] ?? 'list'
  switch (sub) {
    case 'list':
      listConfig(dir)
      return 0
    case 'get':
      if (!argv[1]) { console.error('usage: agentlenspro config get <key>'); return 1 }
      return getConfig(dir, argv[1])
    case 'set':
      if (!argv[1] || argv[2] === undefined) { console.error('usage: agentlenspro config set <key> <value>'); return 1 }
      try {
        return await setConfig(dir, argv[1], argv[2])
      } catch (e) {
        console.error((e as Error).message)
        return 1
      }
    default:
      console.error(`unknown config subcommand: ${sub}\nusage: agentlenspro config [list] | config get <key> | config set <key> <value>`)
      return 1
  }
}
