// src/environment/tooling.ts — developer-tooling inventory (TRDD-HUWJVQJA). Probes a fixed catalog
// of runtimes, package managers, compilers, linters, and version managers via `toolVersion` (PATH
// check + a fast, time-boxed version call) and reports which ones are present. All probes run
// concurrently so the facet stays fast even with dozens of tools in the catalog.

import * as path from 'path'
import { toolVersion } from './exec'
import type { EnvFacet } from './types'

interface ToolEntry {
  bin: string
  args?: string[]
}

/** The tools probed per category. Extend by adding entries — gather() picks them up automatically. */
export const TOOL_CATALOG: Record<string, ToolEntry[]> = {
  runtimes: [
    { bin: 'node' },
    { bin: 'python3' },
    { bin: 'ruby' },
    { bin: 'go', args: ['version'] },
    { bin: 'java', args: ['-version'] },
    { bin: 'deno' },
    { bin: 'bun' },
    { bin: 'php' },
  ],
  packageManagers: [
    { bin: 'npm' },
    { bin: 'pnpm' },
    { bin: 'yarn' },
    { bin: 'bun' },
    { bin: 'brew' },
    { bin: 'apt-get', args: ['--version'] },
    { bin: 'dnf' },
    { bin: 'pacman', args: ['-V'] },
    { bin: 'cargo' },
    { bin: 'uv' },
    { bin: 'pip3' },
    { bin: 'pipx' },
    { bin: 'gem' },
    { bin: 'poetry' },
  ],
  compilers: [
    { bin: 'gcc' },
    { bin: 'clang' },
    { bin: 'rustc' },
    { bin: 'go', args: ['version'] },
    { bin: 'javac', args: ['-version'] },
    { bin: 'tsc' },
  ],
  linters: [
    { bin: 'eslint' },
    { bin: 'prettier' },
    { bin: 'ruff' },
    { bin: 'mypy' },
    { bin: 'black' },
    { bin: 'flake8' },
    { bin: 'golangci-lint' },
    { bin: 'shellcheck' },
  ],
  versionManagers: [
    { bin: 'pyenv' },
    { bin: 'rbenv' },
    { bin: 'asdf' },
    { bin: 'fnm' },
    { bin: 'volta' },
  ],
}

interface ActiveRuntimes {
  venv: string | null
  conda: string | null
  nvmDir: string | null
}

interface ToolingFacetData {
  present: Record<string, Record<string, string>>
  activeRuntimes: ActiveRuntimes
  pathEntries: number
}

/** Which language-runtime environment (if any) is currently active. Pure — takes an injectable env
 *  so it is testable without touching the real process environment. */
export function runtimesFromEnv(env: NodeJS.ProcessEnv): ActiveRuntimes {
  return {
    venv: env.VIRTUAL_ENV || null,
    conda: env.CONDA_DEFAULT_ENV || null,
    nvmDir: env.NVM_DIR || null,
  }
}

async function gather(): Promise<ToolingFacetData> {
  const flat: (ToolEntry & { category: string })[] = []
  for (const category of Object.keys(TOOL_CATALOG)) {
    for (const entry of TOOL_CATALOG[category]) flat.push({ ...entry, category })
  }
  // One Promise.all across every probe (not per-category) so the facet's wall time is bounded by the
  // slowest single tool, not by category count × tool count.
  const results = await Promise.all(
    flat.map(async (item) => ({ category: item.category, bin: item.bin, version: await toolVersion(item.bin, item.args) })),
  )
  const present: Record<string, Record<string, string>> = {}
  for (const r of results) {
    if (!r.version) continue
    const bucket = present[r.category] ?? (present[r.category] = {})
    if (!(r.bin in bucket)) bucket[r.bin] = r.version // dedupe within a category — first wins
  }
  return {
    present,
    activeRuntimes: runtimesFromEnv(process.env),
    pathEntries: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).length,
  }
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function render(value: unknown): string {
  const v = value as ToolingFacetData
  const lines: string[] = []
  for (const category of Object.keys(v.present)) {
    const bucket = v.present[category]
    const bins = Object.keys(bucket)
    if (bins.length === 0) continue
    const entries = bins.map((bin) => `${bin}@${truncate(bucket[bin])}`)
    lines.push(`${(category + ':').padEnd(16)} ${entries.join('  ')}`)
  }
  const { venv, conda } = v.activeRuntimes
  if (venv || conda) {
    const parts: string[] = []
    if (venv) parts.push(`venv=${venv}`)
    if (conda) parts.push(`conda=${conda}`)
    lines.push('active:'.padEnd(15) + parts.join('  '))
  }
  return lines.join('\n')
}

export const toolingFacet: EnvFacet = {
  name: 'tooling',
  aliases: ['tools', 'dev'],
  summary: 'Dev-tooling inventory: runtimes, package managers, compilers, linters, version managers',
  gather,
  render,
}
