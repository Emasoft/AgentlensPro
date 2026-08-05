// src/cli/envCli.ts — `agentlenspro env` (TRDD-HUWJVQJA): report the runtime environment. One facet
// at a time (`env terminal`), or the whole environment at once. Big reports go to a file with `--out`
// (only a one-line digest hits stdout) — the token-economy path the whole diagnostics CLI follows.

import * as fs from 'fs'
import * as path from 'path'
import { strArg } from './argHelpers'
import { FACETS, gatherAll, resolveFacet } from '../environment'
import type { EnvFacet } from '../environment/types'

/** Gather one facet, catching a stray throw so a single misbehaving detector can never reject the
 *  whole command (mirrors the per-facet backstop in gatherAll). Returns the { error } shape on failure. */
async function gatherOne(facet: EnvFacet): Promise<unknown> {
  try {
    return await facet.gather()
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Render a facet value, tolerating both the { error } backstop shape and a throw from render() — the
 *  env report must ALWAYS print something for every facet, never crash partway through. */
function renderSafe(facet: EnvFacet, value: unknown): string {
  if (value && typeof value === 'object' && 'error' in (value as object)) {
    return `  (unavailable: ${String((value as { error: unknown }).error)})`
  }
  try {
    return facet.render(value)
  } catch (e) {
    return `  (render error: ${(e as Error).message})`
  }
}

interface ParsedArgs {
  facet: string | null
  json: boolean
  out: string | null
  list: boolean
}

function parse(argv: string[]): ParsedArgs {
  const p: ParsedArgs = { facet: null, json: false, out: null, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') p.json = true
    // Both spellings validate. `?? null` silently DROPPED the request twice over: `--out` as the last
    // token wrote nothing and printed the report to stdout with exit 0 (a request not fulfilled,
    // reported as success), and `--out --json` wrote a file literally named "--json" while swallowing
    // the --json that was asked for. `--out=` with an empty value is the same silent drop; strArg
    // rejects the empty string too. Both measured before this fix.
    else if (a === '--out') p.out = strArg(argv[++i], '--out', 'a path')
    else if (a.startsWith('--out=')) p.out = strArg(a.slice('--out='.length), '--out=', 'a path')
    else if (a === 'list' || a === '--list') p.list = true
    else if (!a.startsWith('-') && p.facet === null) p.facet = a
  }
  return p
}

function listFacets(): void {
  console.log('environment facets (query one, or omit for the whole report):\n')
  const w = Math.max(...FACETS.map((f) => f.name.length))
  for (const f of FACETS) {
    const aliases = f.aliases.length ? `  (${f.aliases.join(', ')})` : ''
    console.log(`  ${f.name.padEnd(w)}  ${f.summary}${aliases}`)
  }
  console.log('\nflags:  --json (machine-readable)   --out FILE (full JSON to disk, digest to stdout)')
}

/** Write JSON to a file, printing only a one-line digest to stdout (token economy). */
function writeOut(outPath: string, payload: unknown, label: string): number {
  const json = JSON.stringify(payload, null, 2)
  try {
    const dir = path.dirname(path.resolve(outPath))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(outPath, json + '\n', 'utf-8')
  } catch (e) {
    console.error(`could not write ${outPath}: ${(e as Error).message}`)
    return 1
  }
  console.log(`wrote ${outPath}  (${label}, ${Buffer.byteLength(json)} bytes)`)
  return 0
}

/** Entry for `agentlenspro env [...]`. Async (detectors probe the system). Returns the exit code. */
export async function runEnvCli(argv: string[]): Promise<number> {
  const args = parse(argv)
  if (args.list) {
    listFacets()
    return 0
  }

  // One facet.
  if (args.facet) {
    const facet = resolveFacet(args.facet)
    if (!facet) {
      console.error(`unknown facet: ${args.facet}\nknown: ${FACETS.map((f) => f.name).join(', ')}  (run: agentlenspro env list)`)
      return 1
    }
    const value = await gatherOne(facet)
    if (args.out) return writeOut(args.out, value, `facet ${facet.name}`)
    if (args.json) {
      console.log(JSON.stringify(value, null, 2))
      return 0
    }
    console.log(renderSafe(facet, value))
    return 0
  }

  // The whole environment.
  const report = await gatherAll()
  if (args.out) return writeOut(args.out, report, `${FACETS.length} facets`)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }
  const blocks: string[] = [`environment report — ${report.capturedAt}`]
  for (const f of FACETS) {
    blocks.push(`\n── ${f.name} ${'─'.repeat(Math.max(0, 40 - f.name.length))}`)
    blocks.push(renderSafe(f, report.facets[f.name]))
  }
  console.log(blocks.join('\n'))
  return 0
}
