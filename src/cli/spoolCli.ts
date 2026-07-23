// `agentlenspro spool ensure` (TRDD-K3WDPR7M Phase 3, item 6) — the tiny subcommand the boot-remount
// LaunchAgent runs at login. It re-creates the RAM-disk spool IFF raw-body capture is on; otherwise it
// is a deliberate no-op (an off machine must never allocate a ram disk). Fail-fast: a spool that cannot
// be (re)created exits non-zero and says so, never silently.
import { dataDir } from './cliCore'
import { EXIT } from './cliErrors'
import { rawBodyCaptureEnabled } from '../captureConfig'
import { ensureRamDisk, spoolSizeMb, type EnsureRamDiskResult } from '../ramdisk'

export interface SpoolCliDeps {
  ensureRamDisk: (sizeMb: number) => EnsureRamDiskResult
}

/** Entry for `agentlenspro spool [...]`. Returns the process exit code. */
export function runSpoolCli(
  argv: string[],
  deps: SpoolCliDeps = { ensureRamDisk: (mb) => ensureRamDisk(mb) },
): number {
  const sub = argv[0] ?? 'ensure'
  if (sub === 'ensure') {
    const dir = dataDir()
    if (!rawBodyCaptureEnabled(dir, process.env)) {
      console.log('raw-body capture is OFF — no RAM-disk spool needed.')
      return EXIT.OK
    }
    try {
      const r = deps.ensureRamDisk(spoolSizeMb(process.env))
      console.log(`RAM-disk spool ready → ${r.mountPoint} (${Math.round(r.sizeBytes / 1048576)} MB)`)
      return EXIT.OK
    } catch (e) {
      // A spool that cannot be (re)created is a runtime ABORT, not a caller mistake — keep exit 1.
      console.error(`spool ensure failed: ${(e as Error).message}`)
      return EXIT.ABORT
    }
  }
  console.error(`unknown spool subcommand: ${sub}\nusage: agentlenspro spool ensure`)
  return EXIT.USAGE
}
