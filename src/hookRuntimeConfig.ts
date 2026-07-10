// Runtime hook configuration (TRDD-O981ZJKV follow-on): the enable/disable switches for the
// AgentLens hooks, changeable in REALTIME for every running Claude Code session at once.
//
// Why server-side: Claude Code reads hook REGISTRATIONS from settings.json only at session
// start — they cannot be hot-swapped into running sessions (verified: 0 fires before restart,
// 10/10 after). But every registered AgentLens hook is a dumb curl to THIS server, so the
// on/off decision lives here: flip a flag and the behavior changes instantly, system-wide,
// no restarts. The registrations stay static and always-on-cheap; the server decides.
//
// Persisted at ~/.agentlens/hook-config.json (atomic tmp+rename write — a crash mid-write
// must never leave a truncated config that fails the next boot's parse).

import * as fs from 'fs'
import * as path from 'path'

export interface HookRuntimeConfig {
  /** Store lifecycle hook events (spy-agentlens.sh forwarder). Off = accept + drop. */
  captureEnabled: boolean
  /** The PreToolUse burn-gate. Off = every launch allowed silently. */
  gateEnabled: boolean
  /** enforce = deny disasters; warn = downgrade every deny to a systemMessage warning. */
  gateMode: 'enforce' | 'warn'
  /** The PostToolUse in-band advisory to the model. */
  advisorEnabled: boolean
}

export const HOOK_CONFIG_DEFAULTS: HookRuntimeConfig = {
  captureEnabled: true,
  gateEnabled: true,
  gateMode: 'enforce',
  advisorEnabled: true,
}

function coerce(raw: unknown, envMode: string | undefined): HookRuntimeConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
  // Precedence for gateMode: file > AGENTLENS_GATE_MODE env > default. The env stays honored
  // so a pre-config-file deployment keeps behaving; the file wins once anything is saved.
  const mode = o.gateMode === 'warn' || o.gateMode === 'enforce'
    ? o.gateMode
    : envMode === 'warn' ? 'warn' : HOOK_CONFIG_DEFAULTS.gateMode
  return {
    captureEnabled: bool(o.captureEnabled, HOOK_CONFIG_DEFAULTS.captureEnabled),
    gateEnabled: bool(o.gateEnabled, HOOK_CONFIG_DEFAULTS.gateEnabled),
    gateMode: mode,
    advisorEnabled: bool(o.advisorEnabled, HOOK_CONFIG_DEFAULTS.advisorEnabled),
  }
}

export function loadHookRuntimeConfig(file: string, envMode: string | undefined = process.env.AGENTLENS_GATE_MODE): HookRuntimeConfig {
  try {
    return coerce(JSON.parse(fs.readFileSync(file, 'utf-8')), envMode)
  } catch {
    return coerce({}, envMode) // absent or unparseable — defaults (+env), never a crash
  }
}

/** Merge a partial update, persist atomically, return the applied config. Unknown keys are
 *  ignored (a typo must not brick the hooks); invalid values fall back to the current ones. */
export function saveHookRuntimeConfig(file: string, current: HookRuntimeConfig, patch: Record<string, unknown>): HookRuntimeConfig {
  const merged = coerce({ ...current, ...patch }, undefined)
  // gateMode from coerce falls back to 'enforce' when the patch value is junk — keep current instead.
  if (patch.gateMode !== undefined && patch.gateMode !== 'warn' && patch.gateMode !== 'enforce') {
    merged.gateMode = current.gateMode
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return merged
}
