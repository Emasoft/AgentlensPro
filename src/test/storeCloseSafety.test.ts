// WHY THIS FILE EXISTS (2026-08-13): four consecutive full-suite runs died at exit 139. The
// macOS crash reports (node-2026-08-13-05*.ips) all carry the same signature — SIGSEGV inside
// libduckdb at duckdb::ClientContext::Query → pthread_mutex_lock on a freed address, on a
// Napi::AsyncWorker thread-pool thread. The causal chain: under machine load a DuckDB query
// outlives mocha's 10s timeout, mocha abandons the test (the promise keeps running) and moves to
// teardown, teardown calls store.close(), and a bare closeSync() frees the native connection
// WHILE the abandoned query is still executing on the worker thread. The red test moves between
// runs (whichever times out first) but the segfault is the one killer.
//
// The contract pinned here: close() must interrupt, DRAIN every in-flight native call, and only
// then free — and a connection must refuse work after close() instead of touching freed state.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openStore, Store } from '../store/db'

suite('store close safety — close() must never free a connection under a running query', () => {
  let dir: string
  let store: Store
  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-close-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => {
    // close() is under test; a second close must be harmless (see the idempotency test).
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('close() drains an in-flight query instead of freeing the connection under it', async function () {
    // Generous ceiling: on the FIXED path close() interrupts the scan so this finishes in ms; the
    // ceiling only matters if interrupt lands before the scan starts, where close waits it out.
    this.timeout(30_000)
    let settled = false
    // A scan big enough to still be running when close() is called — sum() forces a real scan
    // (count(*) over a table function can short-circuit). The caller deliberately does NOT await:
    // this is the abandoned-by-mocha-timeout shape that killed the suite runs.
    const inflight = store.con.runAndReadAll('SELECT sum(i) FROM range(2000000000) t(i)')
      .then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 50)) // let the worker thread actually pick it up
    await store.close()
    assert.strictEqual(
      settled, true,
      'close() resolved while a query was still on the native thread pool — that is the ' +
      'use-after-free (SIGSEGV in duckdb ClientContext::Query) that killed four suite runs',
    )
    await inflight
  })

  test('a query fired after close() is refused cleanly instead of touching freed native state', async () => {
    await store.close()
    assert.throws(
      () => store.con.runAndReadAll('SELECT 1'),
      /after close/,
      'a post-close query must be refused by the wrapper — reaching the native binding here is ' +
      'exactly the freed-connection touch the crash reports show',
    )
  })

  test('close() is idempotent — a teardown after an in-test close must not double-free', async () => {
    await store.close()
    await store.close() // the teardown above makes a third call; all must resolve without throwing
  })
})
