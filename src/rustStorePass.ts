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
import { npmPlatformBin } from './rustBinResolve'

/** The opted-in binary path, or null when the Rust pass engine is off. Read per call, not at
 *  module load, so tests (and a daemon restarted with new env) see the current value.
 *
 *  Three channels, checked in order:
 *  - AGENTLENS_ALSTORE=/path — per-process override, wins;
 *  - `<dataDir>/bin/alstore` existing — the durable dev-install location. `dataPath` follows the
 *    test-overridden data dir, so fixture-driven tests keep exercising the TS pass on machines
 *    that have the binary installed in the REAL data dir. The file only exists because the
 *    operator copied it there, so presence IS the opt-in;
 *  - the `agentlenspro-<platform>` optionalDependency (TRDD-EAK9R8IY) — what a plain
 *    `npm i -g agentlenspro` resolves with no operator action at all. */
export function alstoreBin(env: NodeJS.ProcessEnv = process.env, installed = dataPath('bin', 'alstore')): string | null {
  const v = env.AGENTLENS_ALSTORE?.trim()
  if (v) return v
  try {
    if (fs.statSync(installed).isFile()) return installed
  } catch {
    // fall through to the npm platform package
  }
  return npmPlatformBin('alstore')
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

/** TRDD-8TM7I49X: remove names from the persisted stranded set through the binary that OWNS the
 *  state file. Never a TS read-modify-write of .pass-state.json — that is exactly the unlocked
 *  interleaving pass.rs warns about, and the bodies pass runs every 60s. Returns null on exit 75
 *  (a pass owns the store's flock right now — benign, retry); throws on everything else. */
export async function rustUnpark(bin: string, storeDir: string, namesFile: string):
  Promise<{ requested: number; removed: number; strandedRemaining: number } | null> {
  const stdout = await new Promise<string | null>((resolve, reject) => {
    execFile(bin, ['unpark', storeDir, '--names-file', namesFile], { maxBuffer: 1 << 22 }, (err, out, stderr) => {
      if (err && (err as { code?: unknown }).code === 75) resolve(null)
      else if (err) reject(new Error(`alstore unpark failed (${bin}): ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`))
      else resolve(out)
    })
  })
  if (stdout === null) return null
  return JSON.parse(stdout) as { requested: number; removed: number; strandedRemaining: number }
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
interface ParkedGauge { files: number; bytes: number; onDisk: number }
let parkedCache: { key: string; value: ParkedGauge } | null = null

/** Drop the memo. Exported for TESTS, which otherwise inherit each other's cache: a module-level
 *  cache makes an ordered suite pass for reasons unrelated to the code under test. Two of the
 *  gauge's own tests write same-length JSON into the same temp store, so equal `size` plus a
 *  coarse-granularity `mtimeMs` (ext4's 1 s inode timestamps, some CI overlayfs) would return the
 *  PREVIOUS test's bytes. On APFS the sub-millisecond float hides it — i.e. the suite would rest
 *  on filesystem timestamp resolution, an environmental accident rather than an invariant. */
export function resetParkedBodiesGaugeCache(): void { parkedCache = null }

export function parkedBodiesGauge(
  storeDir: string,
  liveDirs: readonly string[],
): ParkedGauge | null {
  const statePath = `${storeDir}/.pass-state.json`
  // MEMOISED ON THE STATE FILE'S OWN IDENTITY (mtime+size+dirs), because this is NOT a cold path:
  // /api/server-stats is admission-EXEMPT by design (standalone/server.ts — "an admission slot for
  // its whole lifetime would drain the pool"), and it is polled every 250 ms by the readiness
  // loop, the stop loop and findServerPid(). Measured before this cache: 14.7 ms per call — 1045
  // names × 2 dirs, of which the spool pass throws and catches ~1045 ENOENT exceptions. Putting
  // the payload's most expensive item on the one endpoint engineered to stay cheap under duress
  // is precisely backwards, so the stat storm now runs only when the park actually changed.
  //
  // THE KEY MUST COVER EVERY INPUT, and the first version did not. It keyed on the state file
  // alone, justified as "the pass rewrites it exactly when the answer can change" — which is a
  // PROXY, and false: `bytes`/`onDisk` come from FILES, and files vanish without the pass touching
  // its state (`/api/bodies/purge`, a manual cleanup, a server killed mid-drain). The line could
  // then report `PARKED 1045 file(s) 317.6MB` long after the bytes were gone, and the
  // `onDisk < files` transition this gauge exists to surface would be invisible until the pass
  // happened to rewrite. Fast and stale-wrong is worse than 14.7 ms and right.
  //
  // A DIRECTORY's mtime changes on every entry add or unlink, so stat-ing the dirs is the actual
  // signal for "files vanished" — 1 + N stats instead of 1045, and it invalidates on the events
  // the state file cannot see. (Not covered: a parked file whose CONTENT is rewritten in place
  // without changing the dir. Bodies are immutable once written, so that is not a real state —
  // said explicitly rather than left as an unstated assumption.)
  let key: string
  let parsed: unknown
  try {
    const st = fs.statSync(statePath)
    // ENTRY COUNT, not mtime alone. POSIX does guarantee an add/unlink bumps the parent's mtime,
    // so the mechanism is sound — but ext4 stores inode timestamps at 1 s granularity (some CI
    // overlayfs likewise), so TWO unlinks inside the same second leave mtime unchanged: the first
    // invalidates, the second is invisible, and the gauge serves bytes that are gone. That is the
    // identical granularity hole found in this gauge's own test suite one round earlier; fixing it
    // there and leaving it in the code under test would be the worse half of the lesson. One
    // readdir per dir still beats the 1045 stats this cache exists to avoid.
    const dirKeys = liveDirs.map((d) => {
      try { return `${d}@${fs.statSync(d).mtimeMs}#${fs.readdirSync(d).length}` } catch { return `${d}@absent` }
    })
    key = `${st.mtimeMs}:${st.size}:${dirKeys.join('|')}`
    if (parkedCache !== null && parkedCache.key === key) return parkedCache.value
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    // Do NOT serve a stale cache here: an unreadable state file is a DIFFERENT answer (null =
    // "could not look"), and returning the last good gauge would assert a park we can no longer see.
    parkedCache = null
    return null
  }
  const names = (parsed as { strandedNames?: unknown })?.strandedNames
  if (!Array.isArray(names)) return null
  // ONE population, filtered ONCE, and `files` counts THAT — not the raw array. Counting the raw
  // array while stat-ing only the strings makes `onDisk < files` for a reason that is not "a name
  // outlived its file", so the line would report a fabricated ghost. A non-string in this array is
  // corruption we cannot act on; excluding it from both numbers keeps them describing one set.
  const parked = new Set<string>(names.filter((n): n is string => typeof n === 'string'))
  const remaining = new Set<string>(parked)
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
  const value = { files: parked.size, bytes, onDisk }
  parkedCache = { key, value }
  return value
}
