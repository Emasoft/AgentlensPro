// Child-process TS-side opencode parse for the REAL-db parity test (rustOpenCode.test.ts).
// WHY a child: sql.js WASM memory never shrinks for the life of a process, and the real db
// (~160MB + WAL, byte-copied AND WAL-merged = multiple full copies) would ride the mocha
// process's RSS past the 4096MB rssPressure HWM — which flips compressSealedSegments into its
// defensive skip and fails seven unrelated gz tests plus the HWM default test. The child pays
// the memory and dies with it. Prints the JSON results array on stdout; exits 1 on any error.
import * as path from 'path'
import { LogReader, type OpenCodeSqlFactory } from '../../logReader'

async function main(): Promise<void> {
  const dbPath = process.argv[2]
  if (!dbPath) {
    throw new Error('usage: opencodeParseChild.js <opencode.db>')
  }
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<unknown>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const reader = new LogReader({ sqlFactory: SQL as OpenCodeSqlFactory })
  const results = (reader as unknown as { _parseOpenCodeDb(p: string): unknown })._parseOpenCodeDb(dbPath)
  process.stdout.write(JSON.stringify(results))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
