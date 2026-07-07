import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'
import { safeConfigEdit, SafeEditError } from './safeConfigEdit'

export interface ConfigResult {
  changed: boolean
  error?: string
}

// NOTE: there is deliberately NO autoConfigureClaudeCode here any more. The old
// implementation answered a JSON parse failure by rebuilding ~/.claude/settings.json
// from scratch, and on 2026-07-07 it destroyed a user's whole Claude Code
// configuration (57.8KB → 620 bytes). Claude Code telemetry env is owned by
// ensureTelemetryConfig (src/telemetryConfig.ts) and the automation Stop hook by
// ensureAgentLensStopHook — both write through the transactional,
// verify-before-commit editor (scripts/safe_config_edit.py). Every writer in THIS
// file goes through that same editor: no direct fs.writeFile on user configs, ever.

export async function autoConfigureCodex(port: number): Promise<ConfigResult> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const endpoint = `http://localhost:${port}`

  try {
    const result = await safeConfigEdit(configPath, 'toml', [
      { op: 'ensure_line_in_section', section: 'otel', key_prefix: 'log_user_prompt', line: 'log_user_prompt = true' },
      { op: 'ensure_line_in_section', section: 'otel', key_prefix: 'exporter', line: `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
      { op: 'ensure_line_in_section', section: 'otel', key_prefix: 'trace_exporter', line: `trace_exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
    ], { createIfMissing: true })
    return { changed: result.changed }
  } catch (e) {
    // The editor REFUSES corrupt/unverifiable files and leaves them untouched —
    // surface its reason instead of "recovering" (fail-fast, never rebuild).
    return { changed: false, error: e instanceof SafeEditError ? e.message : String(e) }
  }
}

function vscodeUserSettingsPaths(): string[] {
  const home = os.homedir()
  let base: string
  if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support')
  } else if (process.platform === 'linux') {
    base = path.join(home, '.config')
  } else {
    base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  }
  return VSCODE_FAMILY_IDE_NAMES.map(v => path.join(base, v, 'User', 'settings.json'))
}

export async function autoConfigureCopilotStandalone(port: number): Promise<ConfigResult[]> {
  const results: ConfigResult[] = []

  for (const settingsPath of vscodeUserSettingsPaths()) {
    // Skip IDE variants that aren't installed at all.
    try { await fs.access(path.dirname(settingsPath)) } catch { continue }

    try {
      const result = await safeConfigEdit(settingsPath, 'json', [
        { op: 'set', path: ['github.copilot.chat.otel.enabled'], value: true },
        { op: 'set', path: ['github.copilot.chat.otel.exporterType'], value: 'otlp-http' },
        { op: 'set', path: ['github.copilot.chat.otel.otlpEndpoint'], value: `http://localhost:${port}` },
      ], { createIfMissing: true })
      results.push({ changed: result.changed })
    } catch (e) {
      // VS Code settings.json is often JSONC (comments) — the editor refuses those
      // rather than wiping the comments away with a rebuilt file. Report, don't force.
      results.push({ changed: false, error: e instanceof SafeEditError ? e.message : String(e) })
    }
  }

  return results
}

