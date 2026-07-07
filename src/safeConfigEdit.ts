import { execFile } from 'child_process'
import * as path from 'path'

/**
 * Bridge to scripts/safe_config_edit.py — THE only sanctioned way to modify a
 * user configuration file (~/.claude/settings.json, ~/.codex/config.toml,
 * VS Code settings.json, ...). The Python editor is a verified transaction:
 * snapshot → apply → structural verify-diff (nothing outside the declared op
 * paths may change) → lint → atomic backup → staged write re-read from disk →
 * concurrent-modification check → atomic rename → post-commit audit, with a
 * cross-process lock and bounded retries. On ANY doubt it cancels and leaves
 * the original file untouched.
 *
 * WHY this exists: on 2026-07-07 a direct-fs writer answered a JSON parse
 * failure by rebuilding ~/.claude/settings.json from scratch, destroying the
 * user's whole Claude Code configuration. No TypeScript code may call
 * fs.writeFile on a user config file again — build an ops spec and call this.
 */

export type SafeEditOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'delete'; path: string[] }
  | { op: 'append_unique'; path: string[]; value: unknown; unique_by_substring: string }
  | { op: 'ensure_line_in_section'; section: string; key_prefix: string; line: string }

export interface SafeEditResult {
  changed: boolean
  backupPath: string | null
  attempts: number
}

export class SafeEditError extends Error {
  constructor(message: string, public readonly exitCode: number | null) {
    super(message)
    this.name = 'SafeEditError'
  }
}

// Resolved relative to the bundled output (dist/ or standalone/) — esbuild
// keeps __dirname pointing at the bundle dir, and scripts/ sits beside it in
// both the repo layout and the published package (scripts/ is in "files").
function editorScriptPath(): string {
  const candidates = [
    path.join(__dirname, '..', 'scripts', 'safe_config_edit.py'),
    path.join(__dirname, '..', '..', 'scripts', 'safe_config_edit.py'),
  ]
  // Existence is checked by python failing loudly on a missing file; prefer the
  // first candidate that exists synchronously without adding an fs dependency
  // here — execFile's ENOENT/2 error carries the path for diagnosis either way.
  const fs = require('fs') as typeof import('fs')
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

export async function safeConfigEdit(
  file: string,
  format: 'json' | 'toml',
  ops: SafeEditOp[],
  opts: { createIfMissing?: boolean; retries?: number } = {}
): Promise<SafeEditResult> {
  const args = [
    editorScriptPath(),
    '--file', file,
    '--format', format,
    '--retries', String(opts.retries ?? 3),
  ]
  if (opts.createIfMissing) args.push('--create-if-missing')

  return new Promise<SafeEditResult>((resolve, reject) => {
    const child = execFile('python3', args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        // FAIL-FAST, but with a precise story: the editor prints a JSON error
        // line on stderr with the refusal/verify reason. python3 missing
        // (ENOENT) means config management is unavailable on this machine —
        // callers surface that loudly instead of falling back to unsafe writes.
        let detail = stderr.trim()
        try { detail = (JSON.parse(stderr.trim()) as { error: string }).error } catch { /* raw stderr */ }
        const code = typeof (err as NodeJS.ErrnoException).code === 'number'
          ? (err as unknown as { code: number }).code
          : null
        reject(new SafeEditError(
          detail || `safe_config_edit failed: ${err.message}`,
          code
        ))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()) as SafeEditResult)
      } catch {
        reject(new SafeEditError(`safe_config_edit returned unparseable output: ${stdout.slice(0, 200)}`, null))
      }
    })
    const spec = JSON.stringify({ ops })
    child.stdin?.write(spec)
    child.stdin?.end()
  })
}
