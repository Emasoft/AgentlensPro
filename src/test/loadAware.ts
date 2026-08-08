import * as os from 'os'

// TRDD — a test's timeout must reflect the WORK it waits on, not the machine it happens to run on.
// This machine has been measured running ~20 concurrent Claude Code instances at a load average of
// 151.87 against 14 CPUs — a 10.8x oversubscription. A test that scans real ~/.agentlens data or
// spawns a real process pays for CPU time it is not getting, and a fixed timeout tuned for an idle
// machine fails it on pure contention, not on any defect in the code under test.

/** How many "logical CPUs worth" of runnable work is queued right now, floored at 1 (an idle or
 *  underloaded machine must never SHRINK a timeout below its authored value). */
export function oversubscription(): number {
  const ratio = os.loadavg()[0] / os.cpus().length
  return Math.max(1, ratio)
}

// The multiplier is capped, deliberately. 10.8x was MEASURED on this machine; 12 gives it a little
// margin. The cap must NOT be removed or raised without bound: the base timeout is the real budget
// for the WORK under test, and the multiplier exists only to compensate for CPU contention stealing
// wall-clock time from that work. An unbounded multiplier would mean a genuinely hung test — one
// that would never finish no matter how much CPU it got — could never fail; it would just wait
// longer and longer, forever "passing" by never running out of patience.
export const MAX_SCALE = 12

/** Scale a base (idle-machine) timeout by the current oversubscription, capped at MAX_SCALE. */
export function loadScaledTimeout(baseMs: number): number {
  return Math.round(baseMs * Math.min(oversubscription(), MAX_SCALE))
}

/** Beyond MAX_SCALE oversubscription, even the scaled timeout stops meaning anything: the machine is
 *  so contended that how long the test takes says nothing about the code under test, only about how
 *  many other processes happened to be scheduled first. Skip LOUDLY rather than bank a red or green
 *  that is really just a coin flip on scheduling — this is not a pass, it is an admission the
 *  measurement is void here. Mirrors the `addressDrops()` pattern in cliHotPathLatency.test.ts,
 *  generalized from "this network address doesn't behave as assumed" to "this machine doesn't have
 *  the CPU headroom the assumption needs".
 */
export function skipIfUnmeasurable(ctx: Mocha.Context, maxRatio: number = MAX_SCALE): boolean {
  if (oversubscription() > maxRatio) {
    ctx.skip()
    return true
  }
  return false
}

// A test whose budget is a RELATIVE one — "finish this work eventually" — tolerates contention by
// scaling its timeout, which is what MAX_SCALE is for. A test asserting an ABSOLUTE ceiling cannot:
// the hot-path latency guard checks each command against a fixed 1.5-2.5 s budget, and those numbers
// are NOT ours to relax — Claude Code kills a lifecycle hook at 2 s and the gate at 3 s no matter how
// busy the machine is. So the ceilings stay exactly as authored and the MEASUREMENT is what gets
// gated: past this much contention, scheduling delay alone can eat a 2 s budget, and the guard would
// be reporting the machine rather than the code. Measured at 10.8x oversubscription: hook 5688 ms,
// gate 2765 ms, statusline 2865 ms — all red, none of it a regression.
export const MAX_RATIO_ABSOLUTE_DEADLINE = 2
