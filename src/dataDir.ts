// THE one answer to "where is the AgentlensPro data directory".
//
// WHY IT IS CENTRAL: `$DATA_DIR` is a DOCUMENTED contract — README: "All ingested data lives under
// the data directory (`~/.agentlens`, or `$DATA_DIR`)" — and it is also how the test suite isolates
// itself from the developer's real store. Both break the same way when a module hardcodes the
// default instead of asking: the server writes to the configured directory while a reader looks in
// `~/.agentlens`, finds an empty store, and reports "nothing found" with no hint that it looked in
// the wrong place. That is exactly the failure TRDD-8N3KQW2R fixed for the raw-bodies directory;
// this is the same defect one level up, and it was present in nine modules.
//
// WHY TWO VARIABLE NAMES: `DATA_DIR` is dangerously generic. Docker images, CI systems and
// data-science tooling all set it for their own purposes, and a stray value in the environment
// would silently relocate this tool's entire store — the user's history would appear to vanish
// while the old directory sat untouched on disk. Every other knob here is namespaced
// (`AGENTLENS_UI_URL`, `AGENTLENS_CAPTURE_RAW_BODIES`, `AGENTLENS_GATE`, …); `DATA_DIR` was the
// lone exception, and it was the one pointing at everything.
//
// So `AGENTLENS_DATA_DIR` is canonical and wins. The bare `DATA_DIR` is still honoured because it
// is a shipped, documented contract: dropping it would relocate a real user's store to the default
// and present as data loss — the precise failure mode this module exists to prevent. It is not a
// compatibility shim; it is a second documented input with a defined precedence, and
// `dataDirSource()` makes which one won observable rather than a guess.
//
// Resolved per call, never captured in a module-level const: a const freezes whatever the
// environment was at import time, which is wrong for a long-running server and wrong for a test
// that sets the variable after the module graph is loaded.
import * as os from 'os'
import * as path from 'path'

/** The namespaced, canonical override. Prefer this everywhere. */
export const DATA_DIR_ENV = 'AGENTLENS_DATA_DIR'

/** The legacy generic override — still honoured, but collision-prone. See the header. */
export const DATA_DIR_ENV_GENERIC = 'DATA_DIR'

export type DataDirSource = 'agentlens-env' | 'generic-env' | 'default'

/** The data directory: `$AGENTLENS_DATA_DIR`, else `$DATA_DIR`, else `~/.agentlens`. */
export function dataDir(): string {
  return resolveDataDir().dir
}

/** A path inside the data directory. `dataPath('otel-bodies')` → `<dataDir>/otel-bodies`. */
export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments)
}

/** Which input decided the directory — so `status` output can say so instead of the user guessing
 *  why their store moved. A blank/whitespace value is treated as unset, not as the empty path. */
export function resolveDataDir(): { dir: string; source: DataDirSource } {
  const namespaced = process.env[DATA_DIR_ENV]?.trim()
  if (namespaced) return { dir: namespaced, source: 'agentlens-env' }
  const generic = process.env[DATA_DIR_ENV_GENERIC]?.trim()
  if (generic) return { dir: generic, source: 'generic-env' }
  return { dir: path.join(os.homedir(), '.agentlens'), source: 'default' }
}

/** One line for diagnostics. Names the collision hazard only when the generic variable is what
 *  won — that is the case where an unrelated tool may have moved the store without the user
 *  realising, and the only case where saying so is actionable. */
export function dataDirSource(): string {
  const { dir, source } = resolveDataDir()
  if (source === 'agentlens-env') return `${dir} (from $${DATA_DIR_ENV})`
  if (source === 'generic-env') {
    return `${dir} (from $${DATA_DIR_ENV_GENERIC} — generic name, set $${DATA_DIR_ENV} to be explicit)`
  }
  return `${dir} (default)`
}
