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
  for (const n of stranded) {
    const hit = dirs.map((d) => path.join(d, n)).find((p) => fs.existsSync(p))
    if (hit) found.push(hit)
    else ghosts.push(n)
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
