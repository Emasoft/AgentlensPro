// TRDD-UIDUVNY8 — ensureRamDisk must not leak a twin volume when `diskutil erasevolume` mounts our
// device at "<name> 1" because a racing caller already won the real mount point. A real repro needs
// two concurrent `hdiutil`/`diskutil` calls (macOS-only, no CI sandbox for it), so this stubs
// `execFileSync` via the injection seam to drive the exact race deterministically: `df` (inside
// `ramDiskInfo`) reports "not mounted" for the existing-check and the first post-check, then
// "mounted" on the retry — simulating the winner's volume becoming visible right after we detach
// our own losing device.
import * as assert from 'assert'
import { execFileSync } from 'child_process'
import { ensureRamDisk } from '../ramdisk'

type Call = { cmd: string; args: string[] }

/** A stub matching `typeof execFileSync`'s call shape (cmd, args, opts) => string. `dfMountedOn`
 *  lists the 1-based `df` call indices that should report `mountPoint` as mounted; every other `df`
 *  call throws (df's real behavior for a path that resolves to nothing / a parent fs). */
function makeExecStub(mountPoint: string, dfMountedOn: number[]): { exec: typeof execFileSync; calls: Call[] } {
  const calls: Call[] = []
  let dfCalls = 0
  const exec = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    if (cmd === 'df') {
      dfCalls += 1
      if (dfMountedOn.includes(dfCalls)) {
        // BSD `df -k`: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted-on
        return `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted-on\n`
          + `/dev/disk999 2097152 1024 2096128 1% 10 99990 1% ${mountPoint}\n`
      }
      throw new Error('df: no such file or directory')
    }
    if (cmd === 'hdiutil' && args[0] === 'attach') return '/dev/disk999\n'
    if (cmd === 'diskutil' && args[0] === 'erasevolume') return ''
    if (cmd === 'hdiutil' && args[0] === 'detach') return ''
    throw new Error(`unexpected exec in stub: ${cmd} ${args.join(' ')}`)
  }) as unknown as typeof execFileSync
  return { exec, calls }
}

suite('ramdisk twin — ensureRamDisk detaches the losing device on a name collision (unit)', () => {
  setup(function () {
    // The production code path is macOS-only (assertMac()); the stub replaces `hdiutil`/`diskutil`
    // but not the platform gate, so this suite runs only where the real feature would.
    if (process.platform !== 'darwin') this.skip()
  })

  test('post-check mounted elsewhere ("<name> 1"): detaches our device, then a winner appears on retry', () => {
    const mountPoint = '/Volumes/AgentLensSpoolTestWinner'
    // df: not mounted (existing check, call 1), not mounted (post-check, call 2), mounted (retry, call 3)
    const { exec, calls } = makeExecStub(mountPoint, [3])
    const mkdirCalls: string[] = []
    const r = ensureRamDisk(64, { volumeName: 'AgentLensSpoolTestWinner', exec, mkdirSpoolDir: (mp) => mkdirCalls.push(mp) })

    assert.strictEqual(r.mountPoint, mountPoint, 'returns the WINNER\'s mount, not a twin')
    const detach = calls.find((c) => c.cmd === 'hdiutil' && c.args[0] === 'detach')
    assert.ok(detach, 'hdiutil detach was called')
    assert.strictEqual(detach!.args[1], '/dev/disk999', 'detach targets the device erasevolume actually attached to us')
    // Called once unconditionally right after erasevolume (pre-existing) and again on the retry
    // success branch (both idempotent, real `mkdirSync` with `recursive: true`) — every call must
    // target the winner's mount, never a twin.
    assert.ok(mkdirCalls.length >= 1 && mkdirCalls.every((c) => c === mountPoint),
      `the otel-bodies subdir is ensured only under the winner's mount, got ${JSON.stringify(mkdirCalls)}`)
  })

  test('post-check mounted nowhere: detaches our device, then throws (no leaked device, no false success)', () => {
    const mountPoint = '/Volumes/AgentLensSpoolTestNoWinner'
    // df: not mounted on every call — no winner ever shows up.
    const { exec, calls } = makeExecStub(mountPoint, [])
    assert.throws(
      () => ensureRamDisk(64, { volumeName: 'AgentLensSpoolTestNoWinner', exec, mkdirSpoolDir: () => { /* not reached */ } }),
      /did not mount at .*AgentLensSpoolTestNoWinner after erasevolume/,
    )
    const detach = calls.find((c) => c.cmd === 'hdiutil' && c.args[0] === 'detach')
    assert.ok(detach, 'hdiutil detach was still called before giving up — no device is leaked')
  })
})
