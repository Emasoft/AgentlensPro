// src/cli/argHelpers.ts — flag-parsing primitives shared by the long-lived watcher commands.
// Extracted because `watch` and `budget` had grown their own private copies, and two copies of a
// validator is how one of them quietly stops rejecting something the other still catches.

/** A numeric flag value. Rejects a missing value and NaN rather than coercing to 0 — a silent 0
 *  threshold would make a watcher alert on everything, which reads as a broken feed. */
export function numArg(v: string | undefined, flag: string): number {
  if (v === undefined || v === '') throw new Error(`${flag} expects a number`)
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${v}"`)
  return n
}

/** A string flag value. A following `--flag` means the value was omitted; taking it as the value
 *  would silently consume the next flag and change what the command does. */
export function strArg(v: string | undefined, flag: string): string {
  if (!v || v.startsWith('--')) throw new Error(`${flag} expects a value`)
  return v
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
