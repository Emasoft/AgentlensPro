// src/cli/configCli.ts — `agentlenspro config` (TRDD-ZAV74M8Q): inspect and persist the data
// retention knobs. Reads/writes DATA_DIR/config.json directly (no server round-trip) so it works
// whether or not the server/daemon is running, and the values it writes survive an uninstall/upgrade
// like the data they govern. The effective value obeys the same precedence the server resolves at
// boot: env var > config.json > built-in default. See src/retentionConfig.ts.

import { dataDir } from './cliCore'
import { EXIT } from './cliErrors'
import {
  RETENTION_META, configPath, findMeta, loadRetentionConfig, resolveKnobWithSource, setRetentionKey,
  type RetentionKeyMeta,
} from '../retentionConfig'
import { KEYCHAIN_ENV, KEYCHAIN_KEY, keychainConsentWithSource, setKeychainConsent } from '../keychainConsent'

/** The one non-numeric knob (TRDD-EUURUDQV follow-up): consent to read the OAuth credential from the macOS
 *  keychain. Persisted here rather than left to the server's environment, because an env-only opt-in
 *  is dropped by any restart that does not carry it — and the account archive then stops refreshing
 *  in silence while its rows go on ageing. */
const KEYCHAIN_DESC = 'allow reading the OAuth credential from the macOS keychain, so account usage keeps refreshing'

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
  const kc = keychainConsentWithSource(dir, process.env)
  const rows = [
    ...RETENTION_META.map((m) => {
      const { value, source } = resolveKnobWithSource(m, file, process.env)
      return { key: m.key as string, value: String(value), unit: m.unit, source: source as string, desc: m.desc, env: m.env }
    }),
    { key: KEYCHAIN_KEY, value: kc.allowed ? 'on' : 'off', unit: 'bool', source: kc.source as string, desc: KEYCHAIN_DESC, env: KEYCHAIN_ENV },
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
  if (key === KEYCHAIN_KEY) {
    const { allowed, source } = keychainConsentWithSource(dir, process.env)
    console.log(`${KEYCHAIN_KEY} = ${allowed ? 'on' : 'off'}  (source: ${source}; env ${KEYCHAIN_ENV}; default off)`)
    console.log(KEYCHAIN_DESC)
    return EXIT.OK
  }
  const m = findMeta(key)
  if (!m) {
    console.error(`unknown config key: ${key}\nvalid keys: ${[...RETENTION_META.map((x) => x.key), KEYCHAIN_KEY].join(', ')}`)
    return EXIT.USAGE
  }
  const { value, source } = resolveKnobWithSource(m, loadRetentionConfig(dir), process.env)
  console.log(`${m.key} = ${value} ${m.unit}  (source: ${source}; env ${m.env}; default ${m.def}; min ${m.min})`)
  console.log(m.desc)
  return EXIT.OK
}

/** `agentlenspro config set <key> <value>` — validate and persist to config.json (atomic, non-destructive). */
async function setConfig(dir: string, key: string, rawValue: string): Promise<number> {
  if (key === KEYCHAIN_KEY) {
    const allowed = parseOnOff(rawValue)
    if (allowed === undefined) {
      console.error(`value must be on|off, got: ${JSON.stringify(rawValue)}`)
      return EXIT.USAGE
    }
    // THROWS on an existing non-JSON config rather than clobbering it — same contract as setRetentionKey.
    setKeychainConsent(dir, allowed)
    console.log(`set ${KEYCHAIN_KEY} = ${allowed ? 'on' : 'off'} in ${configPath(dir)}`)
    console.log(allowed
      ? 'the server may now read the keychain, so account usage keeps refreshing across restarts'
      : 'the keychain will not be read; account usage rows will age without refreshing')
    console.log(`restart the server to apply:  agentlenspro server restart`)
    return EXIT.OK
  }
  const m: RetentionKeyMeta | undefined = findMeta(key)
  if (!m) {
    console.error(`unknown config key: ${key}\nvalid keys: ${[...RETENTION_META.map((x) => x.key), KEYCHAIN_KEY].join(', ')}`)
    return EXIT.USAGE
  }
  const value = Number(rawValue)
  if (rawValue.trim() === '' || !Number.isFinite(value)) {
    console.error(`value must be a number, got: ${JSON.stringify(rawValue)}`)
    return EXIT.USAGE
  }
  // setRetentionKey enforces the min floor and THROWS on a corrupt existing file rather than
  // clobbering it — that throw propagates to the top-level fail-fast handler, never a silent reset.
  setRetentionKey(dir, m.key, value)
  console.log(`set ${m.key} = ${value} ${m.unit} in ${configPath(dir)}`)
  console.log(`restart the server/daemon to apply:  agentlenspro server restart`)
  return EXIT.OK
}

/** Entry for `agentlenspro config [...]`. Returns the process exit code (fail-fast, non-zero on error). */
export async function runConfigCli(argv: string[]): Promise<number> {
  const dir = dataDir()
  const sub = argv[0] ?? 'list'
  switch (sub) {
    case 'list':
      listConfig(dir)
      return EXIT.OK
    case 'get':
      if (!argv[1]) { console.error('usage: agentlenspro config get <key>'); return EXIT.USAGE }
      return getConfig(dir, argv[1])
    case 'set':
      if (!argv[1] || argv[2] === undefined) { console.error('usage: agentlenspro config set <key> <value>'); return EXIT.USAGE }
      // A runtime failure (e.g. setRetentionKey refusing a corrupt config.json) propagates to the
      // top-level fail-fast handler — the same uniform exit-1 path list/get already rely on. Only the
      // usage mistakes (here and inside setConfig) carry the distinct EXIT.USAGE (64).
      return await setConfig(dir, argv[1], argv[2])
    default:
      console.error(`unknown config subcommand: ${sub}\nusage: agentlenspro config [list] | config get <key> | config set <key> <value>`)
      return EXIT.USAGE
  }
}
