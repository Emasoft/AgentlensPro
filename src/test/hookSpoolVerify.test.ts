import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendHookEvent, verifyAppendedLine, quarantineSpoolFile } from '../hookEventStore'

// ── Hook-spool drain: verify-before-delete (TRDD-K3WDPR7M, 2026-07-15 USER directive) ──────────────
// drainHookSpool lives in standalone/server.ts (not importable), so it is a THIN composition of two
// exported helpers that ARE unit-testable here against a real filesystem:
//   • verifyAppendedLine — proves the appended line is durable before the drain unlinks the spool copy;
//   • quarantineSpoolFile — moves an un-ingestable payload into rejected/ instead of destroying it.
// A mocked fs would test nothing: the whole contract is "the bytes really landed on disk".

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-spoolverify-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

suite('hook-spool verify-before-delete — verifyAppendedLine (TRDD-K3WDPR7M)', () => {
  test('a durable append (including a non-zero-offset line) verifies byte-for-byte', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const first = appendHookEvent(dir, { hook_event_name: 'SessionStart', session_id: 's1' })
      const second = appendHookEvent(dir, { hook_event_name: 'Stop', session_id: 's1' })
      assert.strictEqual(second.pos.bucketPath, first.pos.bucketPath, 'both land in the same daily bucket')
      assert.strictEqual(second.pos.offset, first.pos.length, 'the second line starts exactly where the first ends')
      // Both read back byte-for-byte from their recorded positions — this is the gate that lets the
      // drain unlink the spool file for each.
      assert.strictEqual(verifyAppendedLine(first.pos, first.line), true, 'the first line is durable')
      assert.strictEqual(verifyAppendedLine(second.pos, second.line), true, 'the non-zero-offset line is durable')
    } finally { cleanup() }
  })

  test('a truncated, overwritten, or wrong-length append fails verification (keeps the spool file)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const a = appendHookEvent(dir, { hook_event_name: 'SessionStart', session_id: 's1' })
      const b = appendHookEvent(dir, { hook_event_name: 'Stop', session_id: 's1' })

      // Truncate the bucket right at b's offset — simulating a crash/short write that ate b's line.
      fs.truncateSync(b.pos.bucketPath, b.pos.offset)
      assert.strictEqual(verifyAppendedLine(b.pos, b.line), false, 'a truncated-away line is NOT durable')
      assert.strictEqual(verifyAppendedLine(a.pos, a.line), true, 'the surviving earlier line still verifies')

      // Same length but different bytes (silent corruption at the same offset) must also fail.
      const c = appendHookEvent(dir, { hook_event_name: 'PreCompact', session_id: 's1' })
      const fd = fs.openSync(c.pos.bucketPath, 'r+')
      try { fs.writeSync(fd, Buffer.alloc(c.pos.length, 0x58 /* 'X' */), 0, c.pos.length, c.pos.offset) }
      finally { fs.closeSync(fd) }
      assert.strictEqual(verifyAppendedLine(c.pos, c.line), false, 'same-length but different bytes are NOT durable')

      // A recorded length that disagrees with the expected line is rejected before any read.
      assert.strictEqual(verifyAppendedLine({ ...a.pos, length: a.pos.length + 1 }, a.line), false, 'a length mismatch fails fast')
    } finally { cleanup() }
  })
})

suite('hook-spool verify-before-delete — quarantineSpoolFile (TRDD-K3WDPR7M)', () => {
  test('an un-ingestable spool payload is moved into rejected/ (never deleted; collisions get suffixed)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const spool = path.join(dir, 'hook-spool')
      const rejected = path.join(spool, 'rejected')
      fs.mkdirSync(spool, { recursive: true })

      const bad = path.join(spool, '1000-bad.json')
      fs.writeFileSync(bad, '{ this is not valid json')
      const dest1 = quarantineSpoolFile(bad, rejected)

      assert.ok(!fs.existsSync(bad), 'the original is gone from the spool root (moved, not copied)')
      assert.strictEqual(dest1, path.join(rejected, '1000-bad.json'), 'kept the same basename in rejected/')
      assert.strictEqual(fs.readFileSync(dest1, 'utf-8'), '{ this is not valid json', 'the bad payload is preserved verbatim — never destroyed')

      // A second file with the SAME basename must not overwrite the first — it is suffixed.
      const bad2 = path.join(spool, '1000-bad.json')
      fs.writeFileSync(bad2, 'different garbage')
      const dest2 = quarantineSpoolFile(bad2, rejected)
      assert.strictEqual(dest2, path.join(rejected, '1000-bad-1.json'), 'a name collision is suffixed, never clobbered')
      assert.strictEqual(fs.readFileSync(dest1, 'utf-8'), '{ this is not valid json', 'the first quarantined file is untouched')
      assert.strictEqual(fs.readFileSync(dest2, 'utf-8'), 'different garbage', 'the second is preserved alongside it')

      // The spool ROOT holds no .json anymore (the drain is unwedged) — the data lives on in rejected/.
      const remaining = fs.readdirSync(spool).filter((n) => n.endsWith('.json'))
      assert.deepStrictEqual(remaining, [], 'spool root drained of .json; rejected/ is a subdir, not counted')
    } finally { cleanup() }
  })
})
