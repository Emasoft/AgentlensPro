import { summarizeSpans } from '../spanSummarizer'
import { DatabaseWriter } from './writer'
import type { Span } from '../shared/telemetryTypes'

// The globalState surface this one-time migration reads/writes. The VS Code
// extension host (which supplied vscode.ExtensionContext) was removed
// (TRDD-6E6416B8); this structural type keeps the migration compiling without a
// `vscode` dependency. It is now exercised only by unit tests.
export interface MigrationContext {
  globalState: {
    get<T>(key: string): T | undefined
    get<T>(key: string, defaultValue: T): T
    update(key: string, value: unknown): PromiseLike<void>
  }
}

const MIGRATION_VERSION_KEY = 'agentLens.dbMigrationVersion'
const SPANS_KEY = 'agentLens.spans'
const CURRENT_VERSION = 1

/**
 * One-time migration: copies spans from globalState into SQLite, then clears
 * globalState. Idempotent — guarded by a version flag so it only runs once.
 * If the writer throws mid-way, globalState is left intact so the next
 * activation can retry.
 */
export async function migrateGlobalStateToSqlite(
  context: MigrationContext,
  writer: DatabaseWriter,
  log: (msg: string) => void,
): Promise<void> {
  const migratedVersion = context.globalState.get<number>(MIGRATION_VERSION_KEY, 0)
  if (migratedVersion >= CURRENT_VERSION) {
    return
  }

  const spans = context.globalState.get<Span[]>(SPANS_KEY, [])
  if (spans.length === 0) {
    await context.globalState.update(MIGRATION_VERSION_KEY, CURRENT_VERSION)
    return
  }

  log(`AgentLens migration: migrating ${spans.length} spans from globalState to SQLite…`)

  const { sessions } = summarizeSpans(spans)
  // The workspace URI used to come from vscode.workspace.workspaceFolders; with
  // the extension host removed (TRDD-6E6416B8) there is no workspace API here,
  // so migrated rows carry an empty workspace (matches the prior empty-folders
  // path, which already resolved to '').
  const workspace = ''

  for (const card of sessions) {
    writer.enqueue(card, workspace)
  }

  try {
    await writer.drain()
  } catch (err) {
    log(`AgentLens migration: write error — globalState NOT cleared: ${err}`)
    return
  }

  await context.globalState.update(SPANS_KEY, [])
  await context.globalState.update(MIGRATION_VERSION_KEY, CURRENT_VERSION)
  log(`AgentLens migration: migrated ${sessions.length} sessions; globalState cleared.`)
}
