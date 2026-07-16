// TRDD-X2E6OSWK — a version-keyed memo for an expensive DERIVED value.
//
// Why this exists: the standalone server rebuilt the WHOLE dashboard model (summarizeSpans over the
// entire in-memory span window + the OTEL/log merge + the subagent link pass + sidebar + analytics)
// from scratch on every push, every burn tick, and every API request — with nothing cached in
// between. A 120s CPU profile of the live server measured that rebuild storm at ~19% of wall-clock
// CPU (reports/cpu-profile/20260714_203932+0200-cpu-spin.md).
//
// The inputs (`spans`, `logSessions`) only change through a handful of mutation points, so the
// cheapest sound cache key is a monotonically increasing VERSION COUNTER bumped at each of them —
// not a TTL (a TTL serves stale data by design) and not a deep hash of the inputs (that costs as
// much as the rebuild it is meant to avoid). Same version in ⇒ byte-identical value out, so this is
// a pure memo: it cannot make the dashboard stale, only faster.
//
// FAIL-FAST: `compute` is NOT wrapped in a try/catch. If the derivation throws, the exception
// propagates to the caller and NOTHING is cached, so the next call recomputes rather than serving a
// half-built value.

export class VersionedCache<T> {
  private version = -1
  private cached: T | undefined
  private populated = false
  private _hits = 0
  private _misses = 0

  /**
   * Returns the memoized value for `version`, computing (and caching) it on the first call for that
   * version. Any other version — higher OR lower — is treated as a miss and replaces the entry:
   * there is exactly one slot, because the only consumer is "the current state of the world".
   */
  get(version: number, compute: () => T): T {
    if (this.populated && this.version === version) {
      this._hits++
      return this.cached as T
    }
    const value = compute()   // may throw — deliberately not caught (see header)
    this.cached = value
    this.version = version
    this.populated = true
    this._misses++
    return value
  }

  /** Drop the entry. Only needed when the value depends on something OUTSIDE the version counter. */
  invalidate(): void {
    this.populated = false
    this.cached = undefined
    this.version = -1
  }

  /** Hit/miss counters — exposed so a debug endpoint (and the tests) can PROVE the cache works. */
  stats(): { hits: number; misses: number } {
    return { hits: this._hits, misses: this._misses }
  }
}
