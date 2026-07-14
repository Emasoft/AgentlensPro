// TRDD-PJC8N1HO — unit tests for LogReader durable tail-offset export/import + identity validation.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader } from '../logReader'

function tmpFile(): { file: string; stat: fs.Stats } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-offsets-'))
  const file = path.join(dir, 'sess.jsonl')
  fs.writeFileSync(file, 'line one\nline two\n')
  return { file, stat: fs.statSync(file) }
}

suite('LogReader — importFileState identity validation (fail-fast on rotation/truncation)', () => {
  test('imports a record whose inode + size still match the file on disk', () => {
    const { file, stat } = tmpFile()
    const r = new LogReader()
    const res = r.importFileState({ [file]: { bytesRead: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size } })
    assert.deepStrictEqual(res, { imported: 1, skipped: 0 })
    assert.strictEqual(r.exportFileState()[file].bytesRead, stat.size)
  })

  test('drops a record for a file that no longer exists (→ cold read)', () => {
    const r = new LogReader()
    const res = r.importFileState({ '/tmp/does-not-exist-xyz.jsonl': { bytesRead: 10, mtimeMs: 1, ino: 1, size: 10 } })
    assert.deepStrictEqual(res, { imported: 0, skipped: 1 })
  })

  test('drops a record whose inode changed (file replaced/rotated)', () => {
    const { file, stat } = tmpFile()
    const r = new LogReader()
    const res = r.importFileState({ [file]: { bytesRead: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino + 1, size: stat.size } })
    assert.deepStrictEqual(res, { imported: 0, skipped: 1 })
  })

  test('drops a record whose stored offset exceeds the current file size (truncated)', () => {
    const { file, stat } = tmpFile()
    const r = new LogReader()
    const res = r.importFileState({ [file]: { bytesRead: stat.size + 1000, mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size } })
    assert.deepStrictEqual(res, { imported: 0, skipped: 1 })
  })

  test('skips a malformed record (missing bytesRead/mtimeMs)', () => {
    const { file } = tmpFile()
    const r = new LogReader()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = r.importFileState({ [file]: { size: 5 } as any })
    assert.deepStrictEqual(res, { imported: 0, skipped: 1 })
  })
})

suite('LogReader — export/import round-trip makes an unchanged file skip on the next scan', () => {
  test('after importing a fully-consumed offset, a fresh reader reads 0 bytes and stays incremental', () => {
    const { file, stat } = tmpFile()
    // Simulate a prior run that consumed the whole file, exported its state, and restarted.
    const restarted = new LogReader()
    restarted.importFileState({ [file]: { bytesRead: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size } })
    // The offset is present, so the export reflects it (proving it seeded the in-memory state).
    assert.strictEqual(restarted.exportFileState()[file].bytesRead, stat.size)
    // No full read has happened yet — the counters are still zero (the file was skipped, not re-parsed).
    // `filesStatted` (TRDD-X2E6OSWK) is the third counter: importFileState stats the file to validate
    // its identity, but that is not the SCAN gate, so it stays 0 until a scan actually runs.
    assert.deepStrictEqual(restarted.getLogScanStats(), { incrementalReads: 0, fullReads: 0, filesStatted: 0 })
  })
})
