// Versioned store migration (TRDD-K3WDPR7M). A schema change must NEVER be able to corrupt or lose
// the corpus — so no migration ever writes into the live store.
//
// THE PROTOCOL (each step exists because skipping it is a known way to lose data):
//
//   1. STAGE      — the migration builds a COMPLETELY NEW store in `<dir>.migrating`. The live store
//                   is opened READ-ONLY and is never mutated. A migration that crashes half-way has
//                   damaged nothing; the live store is exactly as it was.
//   2. VERIFY #1  — the new store must pass validateStore() in FULL: every blob's content hashes to
//                   its own address, and every body reconstructs to bytes whose sha256 equals its
//                   body_id (a fingerprint of the ORIGINAL source file, taken at ingest). Corruption
//                   cannot forge that hash.
//   3. VERIFY #2  — the new store must contain EXACTLY the same set of body_ids as the old one. #1
//                   proves everything present is correct; only #2 proves nothing went MISSING. A
//                   migration that silently drops half the corpus passes #1 with flying colours.
//   4. SWAP       — atomic renames: live -> <dir>.old-vN, staging -> live. A crash mid-swap leaves one
//                   of the two intact, never a blend.
//   5. KEEP       — the old store is RETAINED as `<dir>.old-vN`. It is never deleted by this code.
//                   Reclaiming it is a separate, explicit, human decision (RULE 0).
//
// If ANY step fails, the staging dir is left in place for inspection and the live store is untouched.
// "Migration failed" must always be strictly better than "migration half-succeeded".
import * as fs from 'fs'
import * as path from 'path'
import { allOf, openStore, Store } from './db'
import { emptyCorrections, makeTsRecoveryMigration } from './tsRecovery'
import { validateStore, ValidationReport } from './validate'

/** Bump when the on-disk layout OR the semantics of a column change, and add a Migration below.
 *  v2: body.ts is CAPTURE time everywhere recoverable (v1 backfills stamped ingest time), and every
 *  archive src_name has its own body row (aliases for content-deduped lumps). */
export const CURRENT_SCHEMA = 2

export interface StoreManifest {
  schemaVersion: number
  createdAt: string
  /** Set by a migration, so a store carries its own provenance rather than us having to infer it. */
  migratedFrom?: number
}

export function manifestPath(dir: string): string { return path.join(dir, 'manifest.json') }

/** Read the manifest. A store with NO manifest is schema 0 (it predates versioning) — that is a fact
 *  about the world, not an error, and it must migrate cleanly rather than be rejected. */
export function readManifest(dir: string): StoreManifest {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) as StoreManifest
    if (typeof m.schemaVersion !== 'number') throw new Error('manifest has no schemaVersion')
    return m
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 0, createdAt: new Date(0).toISOString() }
    }
    // A manifest that EXISTS but is unreadable is NOT "schema 0" — treating it as such would migrate
    // a store whose real version we do not know, which is how you corrupt one. Fail loudly.
    throw new Error(`store manifest at ${manifestPath(dir)} is unreadable: ${(e as Error).message}`)
  }
}

export function writeManifest(dir: string, m: StoreManifest): void {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${manifestPath(dir)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  fs.renameSync(tmp, manifestPath(dir)) // atomic — never a half-written manifest
}

/** One schema step. `up` reads the OLD store and writes into the NEW one. It must not mutate `from`. */
export interface Migration {
  from: number
  to: number
  describe: string
  up(from: Store, to: Store): Promise<void>
}

/** Registered steps, applied in order. The default v1->v2 carries EMPTY corrections (a pure copy) —
 *  correct for any store that never had a mis-stamped backfill. The real recovery run passes a
 *  corrections-loaded migration via opts.migrations instead. */
export const MIGRATIONS: Migration[] = [makeTsRecoveryMigration(emptyCorrections())]

export interface MigrateResult {
  migrated: boolean
  fromVersion: number
  toVersion: number
  /** Where the previous store was preserved. Never deleted automatically. */
  backupDir?: string
  validation?: ValidationReport
  /** Body ids in the old store but not the new one. MUST be empty — this is verification #2. */
  missing: string[]
  error?: string
}

async function bodyIds(s: Store): Promise<Set<string>> {
  const rows = (await s.con.runAndReadAll(`SELECT DISTINCT body_id FROM ${allOf(s, 'body')}`)).getRowObjects()
  return new Set(rows.map((r) => String(r.body_id)))
}

/**
 * Bring a store to CURRENT_SCHEMA. Returns a report; the live store is replaced ONLY if every check
 * passed. Never throws on a failed migration — the caller must be able to see WHY and still have its
 * data.
 */
export async function migrateStore(
  dir: string,
  opts: { onProgress?: (m: string) => void; target?: number; migrations?: Migration[] } = {},
): Promise<MigrateResult> {
  const log = opts.onProgress ?? (() => {})
  // `target` exists so the SAFETY RAILS can be tested against a real migration — a framework whose
  // reject-on-loss path has never actually run is a framework you are trusting on faith.
  // `migrations` lets a runner supply a corrections-loaded step (e.g. the real .idx-driven ts
  // recovery) without mutating the module-level registry.
  const target = opts.target ?? CURRENT_SCHEMA
  const registry = opts.migrations ?? MIGRATIONS
  const current = readManifest(dir).schemaVersion
  const res: MigrateResult = { migrated: false, fromVersion: current, toVersion: current, missing: [] }

  if (current === target) return res
  if (current > target) {
    // A store written by a NEWER build. Migrating it "down" would silently discard whatever that
    // build knew and we do not. Refuse.
    res.error = `store is schema v${current} but this build only understands v${target} — refusing to touch it (upgrade AgentlensPro)`
    return res
  }

  const steps = registry.filter((m) => m.from >= current && m.to <= target).sort((a, b) => a.from - b.from)
  // A gap in the chain means we cannot get there from here. Better to stop than to apply a partial
  // chain and leave the store in a version that no code claims to understand.
  // Schema 0 IS the v1 layout (the manifest simply predates versioning), so a 0->N chain legally
  // starts at the 1->… step; without this a pre-manifest store could never reach v2.
  let v = current === 0 ? 1 : current
  // Schema 0 -> 1 is the ONE legal pure stamp: v1 IS the original layout; the manifest simply did
  // not exist yet. Stamping touches no data. (When target > 1 the staged chain below runs from 1
  // and its final manifest carries the real target, so no separate stamp is needed.)
  if (current === 0 && target === 1) {
    writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
    log('stamped an unversioned store as schema v1 (layout unchanged — no data touched)')
    return { ...res, migrated: true, toVersion: 1 }
  }
  for (const s of steps) {
    if (s.from !== v) { res.error = `no migration path from schema v${v} (next step starts at v${s.from})`; return res }
    v = s.to
  }
  if (v !== target) {
    res.error = `no migration path from schema v${current} to v${target}`
    return res
  }

  const staging = `${dir}.migrating`
  const backup = `${dir}.old-v${current}`
  fs.rmSync(staging, { recursive: true, force: true }) // a stale staging dir from a previous crash

  let from: Store | null = null
  let to: Store | null = null
  try {
    from = await openStore({ dir })
    to = await openStore({ dir: staging })

    for (const s of steps) {
      log(`migrating v${s.from} -> v${s.to}: ${s.describe}`)
      await s.up(from, to)
    }

    // VERIFY #1 — everything present in the new store is cryptographically correct.
    log('verifying the migrated store (every blob, every body)…')
    const validation = await validateStore(to)
    res.validation = validation
    if (!validation.valid) {
      res.error = `migrated store FAILED validation (${validation.bodiesOk}/${validation.bodies} bodies, ${validation.blobsOk}/${validation.blobs} blobs) — live store untouched, staging kept at ${staging}`
      return res
    }

    // VERIFY #2 — and nothing went missing. #1 alone would pass a migration that dropped half the
    // corpus: everything it kept would still hash correctly.
    const before = await bodyIds(from)
    const after = await bodyIds(to)
    res.missing = [...before].filter((id) => !after.has(id))
    if (res.missing.length > 0) {
      res.error = `migration LOST ${res.missing.length} of ${before.size} bodies — live store untouched, staging kept at ${staging}`
      return res
    }
    log(`verified: ${validation.bodiesOk} bodies, ${validation.blobsOk} spans, 0 lost`)

    await from.close(); from = null
    await to.close(); to = null

    writeManifest(staging, { schemaVersion: target, createdAt: new Date().toISOString(), migratedFrom: current })

    // SWAP — two atomic renames. A crash between them leaves the corpus in `backup`, never a blend.
    fs.renameSync(dir, backup)
    fs.renameSync(staging, dir)

    log(`migrated v${current} -> v${target}. Previous store KEPT at ${backup} (delete it yourself once you are satisfied).`)
    return { ...res, migrated: true, toVersion: target, backupDir: backup }
  } catch (e) {
    res.error = `migration failed: ${(e as Error).message} — live store untouched, staging kept at ${staging}`
    return res
  } finally {
    await from?.close()
    await to?.close()
  }
}
