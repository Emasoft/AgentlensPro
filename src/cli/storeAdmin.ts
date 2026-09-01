// `agentlenspro store …` — durable-store administration (TRDD-8TM7I49X).
//
// repair-parked: the recovery path for permanently-parked bodies. A body whose bytes verified
// but whose stored ts row disagreed with capture time is parked forever on a durable target
// (pass.rs continues it with no action; the set only grows). The remedy: repair the ts rows
// from the parked files' own mtimes through the FULL staged-migration protocol (stage, verify
// every body, verify nothing lost, atomic swap, keep the old store), then remove the names from
// the stranded set through `alstore unpark` (the binary owns the state file's flock). The next
// pass then routes them to the delete gate normally.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dataDir, dataPath } from '../dataDir'
import { resolveBodiesReadScope } from '../captureConfig'
import { readManifest, repairStore } from '../store/migrate'
import { makeTsRepairStep, parkedMtimeTsMap, emptyCorrections } from '../store/tsRecovery'
import { alstoreBin, rustUnpark } from '../rustStorePass'
import { reviveDisabledOnDisk } from './hookHandlers'
import { apiRequest } from './cliCore'
import { execFileSync } from 'child_process'

/** Names of processes that can WRITE the store, found by snapshotting the process table.
 *
 *  WHY this exists next to the HTTP ping: the ping answers "is the server SERVING", which is a
 *  PROXY for the thing that actually matters — "can anything write the store dir during the swap".
 *  They come apart in both directions that matter: a wedged-but-alive server (mid-boot, stalled
 *  event loop, misconfigured port) fails the ping exactly like a dead one, and an `alstore pass`
 *  child spawned before the stop survives `server stop` entirely. Either one flushes new parts
 *  into the live dir mid-stage, and after the atomic swap those parts are stranded in the backup —
 *  silent divergence, the precise hazard the gate exists to prevent. The stay-down brake stops
 *  FUTURE revives, never a writer that is already live.
 *
 *  Snapshot-then-scan (never `pgrep -f`): the scanning process has the pattern in its own argv and
 *  matches itself. A snapshot taken before the scan cannot contain the scanner. */
function liveStoreWriters(): string[] {
  let table: string
  try {
    table = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch {
    // Fail CLOSED. Unlike the revive brake (whose absence must never stop ingestion), an unreadable
    // process table here means we cannot prove the store is quiescent — and the cost of guessing
    // wrong is silent data loss, not a missed span.
    return ['<could not read the process table — cannot prove the store is quiescent>']
  }
  const self = process.pid
  return table.split('\n').slice(1).filter((line) => {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!Number.isFinite(pid) || pid === self) return false
    // The supervisor is matched by its OWN argv (`… standalone/cli.js server start --supervise`),
    // not by the collector's: it respawns the collector after a backoff, so a scan landing in that
    // gap sees an empty table while a writer is seconds from existing. `alstore unpark` mutates the
    // pass state file, so it counts as a writer too.
    // The supervisor arm is anchored to THIS product's invocations: the cli.js bundle, the
    // compiled out/ layouts (out/cli/, out/test/cli/ — a dev-build supervisor is a real shape),
    // or the linked `agentlenspro` name. The bare `server start --supervise` token pattern would
    // match a stranger's argv, and this gate is fail-CLOSED — a false positive refuses a
    // legitimate repair over someone else's process.
    // A RENAMED shim (`alens -> cli.js`) is out-of-contract by decision, not accident: argv is
    // shown as invoked, not resolved, so name-matching cannot follow an alias. The spawned
    // collector matches the `alcore\s+serve` arm (the standalone/server.js arm is legacy — the
    // TS server was retired in TRDD-1B98LCVR box 4, this pattern just still recognizes an old
    // pidfile/argv from before the cutover).
    // \b before out/ — without it "checkout/cli/…" is a substring hit, and this gate fail-closed
    // over a stranger's path is the exact false positive the anchoring exists to prevent.
    return /standalone\/server\.js|(standalone\/cli\.js|\bout\/(test\/)?cli\/[^ ]+\.js|agentlenspro)\s+server\s+start\b.*--supervise|alcore\s+serve|alstore\s+(pass|unpark)/.test(line)
  }).map((l) => l.trim())
}

export async function runStoreCli(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (sub !== 'repair-parked') {
    console.error('usage: agentlenspro store repair-parked [--dry-run]')
    return 64
  }
  const dryRun = argv.includes('--dry-run')
  const storeDir = dataPath('store')
  const stateFile = path.join(storeDir, '.pass-state.json')

  let stranded: string[]
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { strandedNames?: unknown }
    stranded = Array.isArray(j.strandedNames) ? j.strandedNames.filter((n): n is string => typeof n === 'string') : []
  } catch (e) {
    console.error(`cannot read ${stateFile}: ${(e as Error).message}`)
    return 1
  }
  if (stranded.length === 0) {
    console.log('nothing is parked — the stranded set is empty.')
    return 0
  }

  // Locate each parked name's file across the live dirs (spool + legacy). A name whose file is
  // gone is a GHOST: its capture time is unrecoverable, so it is reported and LEFT PARKED —
  // inventing a ts for it would be fabrication (same rule the v1→v2 recovery followed).
  const dirs = resolveBodiesReadScope(dataDir(), process.env).dirs
  const found: string[] = []
  const ghosts: string[] = []
  const ambiguous: string[] = []
  for (const n of stranded) {
    const hits = dirs.map((d) => path.join(d, n)).filter((p) => fs.existsSync(p))
    if (hits.length === 0) { ghosts.push(n); continue }
    // A name present in MORE than one read dir (spool and legacy) has two candidate mtimes, and
    // taking the first dir's silently picks one capture time over another — a fabricated ts with
    // no signal that a choice was made. Report and leave parked instead: same rule as a ghost.
    // statSync (unlike existsSync) THROWS on ENOENT, and this scan runs BEFORE the quiescence
    // gates — so it reads a tree a live pass may still be deleting from. An uncaught throw here
    // would abort the whole repair over a file that simply moved on. A missing candidate is not
    // ambiguous, it is gone: drop it and judge on what remains.
    const mtimes = hits.map((p) => { try { return fs.statSync(p).mtimeMs } catch { return null } })
                       .filter((m): m is number => m !== null)
    if (mtimes.length === 0) { ghosts.push(n); continue }
    if (new Set(mtimes).size > 1) {
      ambiguous.push(`${n} (${hits.join(', ')})`)
      continue
    }
    found.push(hits[0])
  }
  if (ambiguous.length > 0) {
    console.error(`AMBIGUOUS: ${ambiguous.length} name(s) exist in more than one read dir with DIFFERENT mtimes — left parked (which mtime is the capture time is unknowable here):`)
    for (const a of ambiguous.slice(0, 10)) console.error(`  ${a}`)
  }
  console.log(`parked: ${stranded.length} name(s) — ${found.length} with a live file (repairable), ${ghosts.length} ghost(s) (left parked; capture time unrecoverable)`)
  if (found.length === 0) {
    console.log('nothing repairable.')
    return 0
  }
  if (dryRun) {
    console.log(`dry run: would repair ${found.length} ts row(s) from file mtimes, then unpark them. Sample: ${found.slice(0, 3).map((p) => path.basename(p)).join(', ')}`)
    return 0
  }

  // The staged rewrite swaps the store DIRECTORY. A running server holds open handles on the old
  // inode and would keep writing into the renamed backup — so the server must be down, and the
  // hook revive must be braked or the next tool call resurrects it mid-rewrite.
  let serverUp = false
  try { await apiRequest('GET', '/api/server-stats'); serverUp = true } catch { /* down — good */ }
  if (serverUp) {
    console.error('REFUSED: the server is running — it would keep writing into the swapped-out store. Run `agentlenspro server stop --stay-down` first.')
    return 1
  }
  const writers = liveStoreWriters()
  if (writers.length > 0) {
    console.error('REFUSED: a process that can write the store is still alive — it would flush parts into the swapped-out store:')
    for (const w of writers) console.error(`  ${w}`)
    console.error('Wait for it to exit (or stop it) and re-run. The HTTP ping alone cannot see a wedged server or an already-spawned pass child.')
    return 1
  }
  if (!reviveDisabledOnDisk()) {
    console.error('REFUSED: the hook revive is not braked — any tool call would resurrect the server mid-rewrite. Run `agentlenspro server stop --stay-down` first (it sets the on-disk brake).')
    return 1
  }
  const bin = alstoreBin()
  if (!bin) {
    console.error('REFUSED: no alstore binary — the stranded set lives in the Rust engine\'s state, and unparking it from TS would race the pass (install ~/.agentlens/bin/alstore).')
    return 1
  }

  const corrections = emptyCorrections()
  corrections.tsBySrcName = parkedMtimeTsMap(found)
  const version = readManifest(storeDir).schemaVersion
  const res = await repairStore(storeDir, makeTsRepairStep(corrections, version), { onProgress: (m) => console.log(m) })
  if (!res.migrated) {
    console.error(`repair FAILED: ${res.error ?? 'unknown'} — live store untouched.`)
    return 1
  }

  const namesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'al-unpark-')), 'names.txt')
  fs.writeFileSync(namesFile, found.map((p) => path.basename(p)).join('\n') + '\n')
  const un = await rustUnpark(bin, storeDir, namesFile)
  if (un === null) {
    // With the server down no pass should own the flock; say so rather than spin.
    console.error(`ts rows repaired, but the unpark was locked out (another alstore owns the store). Re-run: ${bin} unpark ${storeDir} --names-file ${namesFile}`)
    return 1
  }
  console.log(`repaired ${corrections.tsBySrcName.size} ts row(s); unparked ${un.removed} name(s) (${un.strandedRemaining} still stranded${ghosts.length ? `, ${ghosts.length} ghost(s)` : ''}).`)
  console.log(`old store KEPT at ${res.backupDir}. Restart the server (\`agentlenspro server start\`) — the next bodies pass reclaims the unparked files.`)
  return 0
}
