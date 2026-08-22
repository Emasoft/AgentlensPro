// src/rustStorePass.ts — exec the Rust `alstore pass` sidecar for the bodies→store ingest pass
// (TRDD-DMWOBWFH P4b: the server stops running the TS in-process ingestPass once opted in; the
// Rust pass carries the identical delete-gate ordering — ingest→FLUSH→fsync barrier→chunked
// verify→delete — ported and proven in P3c).
//
// OPT-IN AND FAIL-FAST, same contract as rustScan.ts/rustLogScan.ts: the engine turns on only via
// an explicit operator act (env or the installed binary), and once opted in a failed exec THROWS —
// a silent fallback to the TS pass would hide a broken deployment behind identical-looking drains.
// The throw lands in archiveOtelBodies' own catch, which warns loudly on every pass tick.
//
// Concurrency note (why exec-ing a second store writer is safe): parts are immutable Parquet files
// with collision-free epoch+pid+seq names and refuse-to-overwrite, and the TS server's open store
// re-lists the parts dir on EVERY query (db.ts parquetScan → partFiles readdir), so Rust-written
// parts are visible to the running server without a reopen. The server never runs its TS ingest
// (the only TS store WRITER) while opted in, so there is exactly one writer per store dir.
// Skip/stranded state lives in `<storeDir>/.pass-state.json`, owned by the binary across
// invocations — the TS in-memory sets stay untouched (they belong to the TS engine).

import { execFile } from 'child_process'
import * as fs from 'fs'
import type { IngestPassResult } from './store/ingestPass'
import { dataPath } from './dataDir'

/** The opted-in binary path, or null when the Rust pass engine is off. Read per call, not at
 *  module load, so tests (and a daemon restarted with new env) see the current value.
 *
 *  Two opt-in channels, both explicit operator acts (never toolchain auto-detection):
 *  - AGENTLENS_ALSTORE=/path — per-process override, wins;
 *  - `<dataDir>/bin/alstore` existing — the durable install location. `dataPath` follows the
 *    test-overridden data dir, so fixture-driven tests keep exercising the TS pass on machines
 *    that have the binary installed in the REAL data dir. The file only exists because the
 *    operator copied it there, so presence IS the opt-in. */
export function alstoreBin(env: NodeJS.ProcessEnv = process.env, installed = dataPath('bin', 'alstore')): string | null {
  const v = env.AGENTLENS_ALSTORE?.trim()
  if (v) return v
  try {
    return fs.statSync(installed).isFile() ? installed : null
  } catch {
    return null
  }
}

/** One throttled ingest pass through the Rust binary — same option meanings and the same result
 *  shape as the TS `ingestPass` (PassResult serializes camelCase field-for-field). Throws on any
 *  exec or parse failure — the caller opted into this engine, so a broken binary must be LOUD.
 *  The ONE non-throwing miss: exit 75 (EX_TEMPFAIL, "another alstore pass owns this store")
 *  returns null — the kernel-flock twin of the in-process bodiesPassRunning guard, a benign
 *  skip-this-tick, not a broken deployment. */
export async function rustIngestPass(bin: string, opts: {
  storeDir: string
  bodiesDir: string
  maxAgeMs: number
  maxBytesPerPass: number
  durableSource: boolean
  relocateStrandedTo?: string
}): Promise<IngestPassResult | null> {
  const args = ['pass', opts.storeDir, opts.bodiesDir,
    '--max-age-ms', String(opts.maxAgeMs),
    '--max-bytes', String(opts.maxBytesPerPass)]
  if (opts.durableSource) args.push('--durable-source')
  if (opts.relocateStrandedTo) args.push('--relocate-to', opts.relocateStrandedTo)
  const stdout = await new Promise<string | null>((resolve, reject) => {
    // maxBuffer sized for a pathological pass (thousands of failed/stranded names in the report).
    execFile(bin, args, { maxBuffer: 1 << 26 }, (err, out, stderr) => {
      if (err && (err as { code?: unknown }).code === 75) resolve(null)
      else if (err) reject(new Error(`alstore pass failed (${bin}): ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`))
      else resolve(out)
    })
  })
  if (stdout === null) return null
  return JSON.parse(stdout) as IngestPassResult
}

/** How many bodies are PARKED, and how much disk they hold down (TRDD-8TM7I49X).
 *
 *  A park is permanent for a durable target: `pass.rs:420-436` `continue`s a parked file with no
 *  action when `relocate_stranded_to` is None, which is what `standalone/server.ts` passes for the
 *  legacy dir. So the set only ever grows, and NOTHING reported it — 1045 files / 317.6 MB were
 *  pinned for days behind a server that printed a healthy status every time it was asked.
 *
 *  The existing `PARKED` warning cannot cover this: it fires on `r.strandedTs.length`, the files
 *  parked during THAT pass, so an already-parked file is silent forever. A monotonic population
 *  needs a GAUGE; an event log can only report the edge. That distinction is the whole bug.
 *
 *  Returns null when the state file is absent or unreadable — an ABSENT reading, never a zero,
 *  because "0 parked" and "I could not look" are opposite claims and only one of them is
 *  reassuring. Sizes come from the files still on disk in `liveDirs`; a parked name whose file is
 *  gone contributes to `files` but not to `bytes` (the name outliving the file is itself worth
 *  seeing, so it is not silently dropped). */
export function parkedBodiesGauge(
  storeDir: string,
  liveDirs: readonly string[],
): { files: number; bytes: number; onDisk: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(`${storeDir}/.pass-state.json`, 'utf8'))
  } catch {
    return null
  }
  const names = (parsed as { strandedNames?: unknown })?.strandedNames
  if (!Array.isArray(names)) return null
  const remaining = new Set<string>(names.filter((n): n is string => typeof n === 'string'))
  let bytes = 0
  let onDisk = 0
  for (const dir of liveDirs) {
    if (remaining.size === 0) break
    for (const name of [...remaining]) {
      try {
        bytes += fs.statSync(`${dir}/${name}`).size
        onDisk++
        // Each name is stat-ed at most once even when both dirs are scanned: a parked name belongs
        // to exactly one file, and re-counting it across dirs would inflate the reported bytes.
        remaining.delete(name)
      } catch { /* not in this dir, or gone — try the next dir */ }
    }
  }
  return { files: new Set(names).size, bytes, onDisk }
}
