// TRDD-X2E6OSWK — the mtime-gated directory-listing cache inside the scratch-tree indexer.
//
// indexScratchTree() runs on EVERY incremental parse of EVERY Claude session (i.e. on every JSONL
// append). It used to readdir the OS temp roots and every `claude-*` tree under them from scratch
// each time — measured at 9.4% of the fixed server's wall-clock CPU under a 4-writer load, the
// largest non-idle cost left after the two loops named in the CPU-spin report.
//
// The cache is gated on each directory's own mtime, which POSIX bumps on every entry create/remove/
// rename. These tests pin the ONE property that makes that sound: it must save readdirs WITHOUT ever
// hiding a newly-created scratch dir or a newly-written file. A cache that loses a generated file is
// worse than the CPU it saves.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { indexScratchTree, clearScratchListingCache, scratchListingStats } from '../generatedFiles'

let seq = 0
function tree(): { root: string; sessionId: string; scratch: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `al-gfc-${process.pid}-${seq++}-`))
  const sessionId = `sess-${process.pid}-${seq++}`
  const scratch = path.join(root, 'claude-test', 'proj-slug', sessionId, 'scratchpad')
  fs.mkdirSync(scratch, { recursive: true })
  return { root, sessionId, scratch, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Run `fn` and report how many REAL readdir calls the indexer made while it ran. */
function countingReaddir<T>(fn: () => T): { result: T; readdirs: number } {
  const before = scratchListingStats().readdirs
  const result = fn()
  return { result, readdirs: scratchListingStats().readdirs - before }
}

suite('scratch-tree listing cache — saves readdirs (TRDD-X2E6OSWK)', () => {
  test('a repeated index of an UNCHANGED tree does zero readdirs the second time', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      fs.writeFileSync(path.join(t.scratch, 'a.txt'), 'hello')

      const first = countingReaddir(() => indexScratchTree(t.sessionId, { tmpRoots: [t.root] }))
      assert.strictEqual(first.result.files.length, 1)
      assert.ok(first.readdirs > 0, 'the first index must actually walk the tree')

      const second = countingReaddir(() => indexScratchTree(t.sessionId, { tmpRoots: [t.root] }))
      assert.strictEqual(second.readdirs, 0, 'an unchanged tree must be served entirely from the listing cache')
      assert.deepStrictEqual(second.result.files.map(f => f.path), first.result.files.map(f => f.path))
    } finally { t.cleanup() }
  })

  test('appending to a session 50 times does NOT re-walk the temp roots 50 times', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      fs.writeFileSync(path.join(t.scratch, 'a.txt'), 'x')
      indexScratchTree(t.sessionId, { tmpRoots: [t.root] })   // warm

      // This is the production hot path: one indexScratchTree per incremental parse of the session's
      // .jsonl. Nothing in the SCRATCH tree changed, so nothing should be re-listed.
      const { readdirs } = countingReaddir(() => {
        for (let i = 0; i < 50; i++) indexScratchTree(t.sessionId, { tmpRoots: [t.root] })
      })
      assert.strictEqual(readdirs, 0, '50 parses of an unchanged scratch tree must cost 0 readdirs')
    } finally { t.cleanup() }
  })
})

suite('scratch-tree listing cache — never hides a change (correctness > speed)', () => {
  test('a file added AFTER the first index is still found', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      fs.writeFileSync(path.join(t.scratch, 'a.txt'), 'one')
      assert.strictEqual(indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.length, 1)

      fs.writeFileSync(path.join(t.scratch, 'b.txt'), 'two')   // bumps the scratch dir's mtime
      const names = indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.map(f => path.basename(f.path)).sort()
      assert.deepStrictEqual(names, ['a.txt', 'b.txt'], 'the new file must appear on the very next index')
    } finally { t.cleanup() }
  })

  test('a file that GREW is reported at its NEW size (sizes are statted fresh, never cached)', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      const f = path.join(t.scratch, 'grow.txt')
      fs.writeFileSync(f, 'ab')
      assert.strictEqual(indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files[0].sizeBytes, 2)

      fs.appendFileSync(f, 'cdef')   // content change: does NOT bump the directory's mtime
      const after = indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files[0]
      assert.strictEqual(after.sizeBytes, 6, 'a cached LISTING must not cache the file size')
    } finally { t.cleanup() }
  })

  test('a scratch dir created for the session AFTER the first index is discovered', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      // First index: the session exists but has no second project slug yet.
      indexScratchTree(t.sessionId, { tmpRoots: [t.root] })

      // A second project slug appears with the SAME session id under it — bumps the uid dir's mtime.
      const other = path.join(t.root, 'claude-test', 'other-slug', t.sessionId, 'tasks')
      fs.mkdirSync(other, { recursive: true })
      fs.writeFileSync(path.join(other, 'task.md'), 'later')

      const files = indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.map(f => path.basename(f.path))
      assert.deepStrictEqual(files, ['task.md'], 'a scratch dir created after the first index must still be found')
    } finally { t.cleanup() }
  })

  test('a whole new claude-* tree appearing under the root is discovered', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      indexScratchTree(t.sessionId, { tmpRoots: [t.root] })

      const fresh = path.join(t.root, 'claude-other-uid', 'slug', t.sessionId)
      fs.mkdirSync(fresh, { recursive: true })   // bumps the ROOT's mtime
      fs.writeFileSync(path.join(fresh, 'new.txt'), 'x')

      const names = indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.map(f => path.basename(f.path))
      assert.ok(names.includes('new.txt'), 'a brand-new claude-* tree must be discovered, not cached away')
    } finally { t.cleanup() }
  })

  test('a deleted scratch dir stops being reported', () => {
    const t = tree()
    try {
      clearScratchListingCache()
      fs.writeFileSync(path.join(t.scratch, 'a.txt'), 'one')
      assert.strictEqual(indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.length, 1)

      fs.rmSync(path.join(t.root, 'claude-test'), { recursive: true, force: true })
      assert.strictEqual(indexScratchTree(t.sessionId, { tmpRoots: [t.root] }).files.length, 0)
    } finally { t.cleanup() }
  })
})
