// src/environment/exec.ts — fail-soft process + PATH helpers for the environment detectors
// (TRDD-HUWJVQJA). Detection must NEVER crash the CLI: every probe here swallows its own failure
// (missing binary, timeout, non-zero exit) and returns a benign empty/false result. Every subprocess
// is time-boxed so a hung tool (an off-cloud `aws`, a stalled `tailscale`) can never wedge the report.

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

/** Run a command with a hard timeout. Never rejects — a failure resolves to { ok:false }. */
export function run(cmd: string, args: string[] = [], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 4000
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout ?? '').toString()
      const errOut = (stderr ?? '').toString()
      if (err) {
        // On a non-zero EXIT the error carries a numeric `code`; when the binary is missing / killed
        // it is a string like 'ENOENT'/'SIGTERM' — normalize the latter to null so callers can rely on
        // `code` being either an exit status or "did not run".
        const raw = (err as { code?: unknown }).code
        resolve({ ok: false, stdout: out, stderr: errOut, code: typeof raw === 'number' ? raw : null })
      } else {
        resolve({ ok: true, stdout: out, stderr: errOut, code: 0 })
      }
    })
  })
}

const WINDOWS = process.platform === 'win32'

/** Resolve a binary in PATH without spawning anything (pure fs) — cross-platform, injectable env for
 *  tests. Returns the absolute path or null. On Windows, tries each PATHEXT extension. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? env.Path ?? ''
  const dirs = pathVar.split(WINDOWS ? ';' : ':').filter(Boolean)
  const exts = WINDOWS ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext)
      try {
        if (!fs.statSync(full).isFile()) continue
      } catch {
        continue // not here
      }
      if (WINDOWS) return full
      try {
        fs.accessSync(full, fs.constants.X_OK)
        return full
      } catch {
        // present but not executable — keep looking
      }
    }
  }
  return null
}

/** First non-empty trimmed line of a string (many tools print a banner after the version). */
export function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** A tool's version string, or null if it is not on PATH. `(installed)` when it runs but prints no
 *  parseable line. Some tools (java, some linters) print the version to STDERR, so we read both. */
export async function toolVersion(
  bin: string,
  args: string[] = ['--version'],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (!which(bin, env)) return null
  const r = await run(bin, args, { timeoutMs: 3000 })
  const line = firstLine(r.stdout) || firstLine(r.stderr)
  return line || (r.ok ? '(installed)' : '(installed, version unknown)')
}
