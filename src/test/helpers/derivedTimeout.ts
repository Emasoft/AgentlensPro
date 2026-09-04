import * as fs from 'fs'

// TRDD-JQ4R8ZKN / TRDD-2R0AXCKL: a real-corpus test's cost is a readdirSync (+ per-entry scan) over
// the WHOLE spool dir — unbounded by any windowHours/scanCap passed to the code under test, since
// those only bound what gets PARSED after the directory is already listed. Runtime therefore tracks
// the LIVE corpus size on this machine, not a constant, and load average is the WRONG knob to scale
// by: measured on this machine, the run that timed out had a LOWER load average than the one that
// passed — the actual cost is IO/CPU contention on the bodies dir, not runnable-queue depth. Derive
// the ceiling from the measured entry count instead: floor keeps a small corpus at its old bound,
// cap makes a runaway corpus fail loudly rather than hang mocha forever.
export function derivedTimeoutMs(dir: string, floorMs: number, msPerEntry = 5, capMs = 600_000): number {
  let entryCount = 0
  try { entryCount = fs.readdirSync(dir).length } catch { /* measured as 0 below */ }
  return Math.min(capMs, Math.max(floorMs, entryCount * msPerEntry))
}
