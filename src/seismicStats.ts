// src/seismicStats.ts — proven statistical primitives for burn-event ("seismic") analysis.
//
// The problem this solves: a "burn" is a rare, large deviation in a per-minute activity/cost series.
// Detecting it with the naive mean ± k·σ is WRONG — the outliers being detected corrupt the very
// mean and σ used to detect them (the "masking" effect). So every primitive here is a NAMED,
// published method chosen for a proven statistical property, and each is unit-tested against a
// textbook constant (src/test/seismicStats.test.ts) so correctness is provable, not asserted.
//
// Pure math only — no Node, no DOM — so it is trivially testable and runtime-neutral.
//
// Methods & citations:
//   • MAD + Iglewicz–Hoaglin modified z-score — Iglewicz & Hoaglin, "How to Detect and Handle
//     Outliers" (ASQC, 1993). Robust: 50% breakdown point; |Mᵢ|>3.5 flags an outlier.
//   • Poisson exceedance p-value — the tail probability of a count under a fitted rate λ.
//   • Benjamini–Hochberg FDR — Benjamini & Hochberg, JRSS-B 57(1), 1995. Controls the expected
//     false-discovery rate among flagged buckets at level α (multiple-comparison correction).
//   • STA/LTA trigger — Allen, BSSA 68(5), 1978. The standard seismic onset/offset event detector.
//   • CUSUM — Page, Biometrika 41, 1954. Sequential mean-shift (change-point) detector.
//   • Lanczos lgamma — Lanczos, SIAM 1964. Accurate log-Γ for the Poisson sum.

// ───────────────────────── robust location / scale ─────────────────────────

/** Median of a sample (average of the two middle order statistics for even n). NaN for empty. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Median Absolute Deviation: median(|xᵢ − med|). Robust scale, 50% breakdown point.
 *  Normal-consistent σ̂ = 1.4826·MAD (see {@link robustBaseline}). */
export function mad(xs: readonly number[], med: number = median(xs)): number {
  if (xs.length === 0) return NaN
  return median(xs.map(x => Math.abs(x - med)))
}

/** Mean absolute deviation about the median — the fallback scale when MAD collapses to 0
 *  (Iglewicz–Hoaglin: many tied values). */
export function meanAbsDev(xs: readonly number[], med: number = median(xs)): number {
  if (xs.length === 0) return NaN
  return xs.reduce((a, x) => a + Math.abs(x - med), 0) / xs.length
}

export interface RobustBaseline {
  median: number
  mad: number
  meanAD: number
  /** Normal-consistent robust σ estimate = 1.4826·MAD. */
  sigmaHat: number
}

/** The robust baseline (median, MAD, meanAD, σ̂) computed once and reused across the series. */
export function robustBaseline(xs: readonly number[]): RobustBaseline {
  const med = median(xs)
  const m = mad(xs, med)
  return { median: med, mad: m, meanAD: meanAbsDev(xs, med), sigmaHat: 1.4826 * m }
}

/** Iglewicz–Hoaglin (1993) modified z-score. |M| > 3.5 ⇒ outlier.
 *  0.6745 = Φ⁻¹(0.75) = 1/1.4826. When MAD collapses, fall back to mean-abs-dev with
 *  √(π/2)=1.253314. The collapse gate is RELATIVE (like robustNoiseSigma): a majority of identical
 *  values leaves MAD ≈ 1e-16 float residue rather than exactly 0, and dividing by a residue scale
 *  turns every point into a fake extreme outlier. NOTE the fallback's known bound: when the
 *  anomalies themselves drive meanAD, a mass-fraction f of shifted points scores at most
 *  z ≈ 1/(1.253314·f) — robustness working as intended (half the data can never be "an outlier"). */
export function modifiedZ(x: number, med: number, madv: number, meanAD: number): number {
  if (madv > 1e-8 * meanAD && madv > 0) return (0.6745 * (x - med)) / madv
  if (meanAD > 0) return (x - med) / (1.253314 * meanAD)
  return 0
}

/** The modified-z series for xs against a (precomputed or fresh) robust baseline. */
export function modifiedZScores(xs: readonly number[], b: RobustBaseline = robustBaseline(xs)): number[] {
  return xs.map(x => modifiedZ(x, b.median, b.mad, b.meanAD))
}

// ───────────────────────── Poisson tail + lgamma ─────────────────────────

const LANCZOS_G = 7
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

/** log Γ(z) via the Lanczos approximation (g=7, 9 coefficients). Accurate to ~1e-13 for z>0. */
export function lgamma(z: number): number {
  if (z < 0.5) {
    // Reflection formula Γ(z)Γ(1−z) = π/sin(πz) extends it below 0.5.
    return Math.log(Math.abs(Math.PI / Math.sin(Math.PI * z))) - lgamma(1 - z)
  }
  z -= 1
  let a = LANCZOS_C[0]
  const t = z + LANCZOS_G + 0.5
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (z + i)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Poisson upper-tail exceedance P(X ≥ k | λ): the probability a rate-λ process produces at least
 *  k events in a bucket. Summed in log-space via lgamma for stability. k integer ≥ 0, λ ≥ 0. */
export function poissonSF(k: number, lambda: number): number {
  if (k <= 0) return 1
  if (lambda <= 0) return 0
  const lnL = Math.log(lambda)
  let cdf = 0 // Σ_{i=0}^{k−1} pmf(i),  pmf(i) = exp(i·lnλ − λ − lnΓ(i+1))
  for (let i = 0; i < k; i++) cdf += Math.exp(i * lnL - lambda - lgamma(i + 1))
  return Math.max(0, Math.min(1, 1 - cdf))
}

// ───────────────────────── standard normal tail ─────────────────────────

// Abramowitz & Stegun 7.1.26 rational approximation of erf (|error| ≤ 1.5e-7).
const ERF_P = 0.3275911
const ERF_A = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]

/** Gauss error function erf(x) via A&S 7.1.26. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + ERF_P * ax)
  const poly = ((((ERF_A[4] * t + ERF_A[3]) * t + ERF_A[2]) * t + ERF_A[1]) * t + ERF_A[0]) * t
  return sign * (1 - poly * Math.exp(-ax * ax))
}

/** Standard-normal CDF Φ(z) = ½(1 + erf(z/√2)). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Standard-normal upper-tail survival 1 − Φ(z). The one-sided p-value of a robust z-score:
 *  a modified-z is already on the ~N(0,1) scale, so normalSf(modZ) is its exceedance probability. */
export function normalSf(z: number): number {
  return Math.max(0, Math.min(1, 1 - normalCdf(z)))
}

// ───────────────────────── Fisher's combined test ─────────────────────────

/** χ² survival function for EXACTLY 4 degrees of freedom — the null of Fisher's method over two
 *  p-values. Closed form (Erlang-2 tail): SF(x) = e^(−x/2)·(1 + x/2). No approximation. */
export function chiSquaredSF4(x: number): number {
  if (!(x > 0)) return 1
  if (!Number.isFinite(x)) return 0
  return Math.exp(-x / 2) * (1 + x / 2)
}

/** Fisher's method (Fisher 1932) for TWO independent p-values: X = −2(ln p₁ + ln p₂) ~ χ²₄ under
 *  H₀. Here p₁ = the Poisson RATE test and p₂ = the lognormal INTENSITY test — independent by
 *  Poisson thinning (arrival counts ⊥ per-arrival marks). A p ≤ 0 is infinitely strong evidence
 *  (combined 0); a p of 1 contributes nothing. */
export function fisherCombine(p1: number, p2: number): number {
  const a = Math.min(1, p1)
  const b = Math.min(1, p2)
  if (a <= 0 || b <= 0) return 0
  return chiSquaredSF4(-2 * (Math.log(a) + Math.log(b)))
}

// ───────────────────────── Benjamini–Hochberg FDR ─────────────────────────

export interface BHResult {
  /** rejected[i] = true ⇒ bucket i is a statistically-significant anomaly at FDR ≤ α. */
  rejected: boolean[]
  /** The BH critical p-value (largest p still rejected); 0 if nothing is significant. */
  threshold: number
  nRejected: number
}

/** Benjamini–Hochberg (1995) step-up FDR control at level α. Among the flagged buckets the expected
 *  proportion of false discoveries is ≤ α — the multiple-comparison correction that turns "z>2 on
 *  480 buckets" (≈24 expected false alarms) into a defensible anomaly set. */
export function benjaminiHochberg(pvalues: readonly number[], alpha: number): BHResult {
  const m = pvalues.length
  const rejected = new Array<boolean>(m).fill(false)
  if (m === 0) return { rejected, threshold: 0, nRejected: 0 }
  const order = pvalues.map((p, i) => [p, i] as [number, number]).sort((a, b) => a[0] - b[0])
  let kMax = -1
  for (let rank = 0; rank < m; rank++) {
    if (order[rank][0] <= ((rank + 1) / m) * alpha) kMax = rank
  }
  for (let rank = 0; rank <= kMax; rank++) rejected[order[rank][1]] = true
  return { rejected, threshold: kMax >= 0 ? ((kMax + 1) / m) * alpha : 0, nRejected: kMax + 1 }
}

/** Benjamini–Yekutieli (2001) step-up: BH run at level α/H(m), H(m)=Σᵢ1/i. Controls FDR ≤ α under
 *  ARBITRARY dependence between the tests (BH alone needs independence or PRDS — plausible for our
 *  positively-correlated one-sided minute buckets, but not guaranteed). The returned `threshold` is
 *  the effective BY critical p. Conservative by the factor H(m) (~ln m). */
export function benjaminiYekutieli(pvalues: readonly number[], alpha: number): BHResult {
  const m = pvalues.length
  if (m === 0) return { rejected: [], threshold: 0, nRejected: 0 }
  let harmonic = 0
  for (let i = 1; i <= m; i++) harmonic += 1 / i
  return benjaminiHochberg(pvalues, alpha / harmonic)
}

// ───────────────────────── STA/LTA event trigger ─────────────────────────

export interface StaLtaTrigger {
  /** Inclusive index of the onset bucket (first ratio ≥ onThresh). */
  from: number
  /** Inclusive index where the event de-triggered (ratio ≤ offThresh) or the series ended. */
  to: number
  peakRatio: number
  peakIndex: number
}

export interface StaLtaResult {
  ratio: number[]
  triggers: StaLtaTrigger[]
}

/** Classic STA/LTA detector (Allen 1978): the ratio of a Short-Term to a Long-Term Average of the
 *  |signal|. An event is ON when the ratio rises past onThresh and OFF when it falls to offThresh —
 *  giving a mathematically-defined onset/offset interval rather than a hand-picked window. Uses
 *  causal windowed averages (a defensible discretization of the recursive form for a binned series). */
export function staLta(
  xs: readonly number[], nsta: number, nlta: number, onThresh: number, offThresh: number,
): StaLtaResult {
  const n = xs.length
  const ratio = new Array<number>(n).fill(0)
  const prefix = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + Math.abs(xs[i])
  const avg = (i: number, w: number): number => {
    const lo = Math.max(0, i - w + 1)
    return (prefix[i + 1] - prefix[lo]) / (i - lo + 1)
  }
  for (let i = 0; i < n; i++) {
    const lta = avg(i, nlta)
    ratio[i] = lta > 0 ? avg(i, nsta) / lta : 0
  }
  const triggers: StaLtaTrigger[] = []
  let cur: StaLtaTrigger | null = null
  for (let i = 0; i < n; i++) {
    if (!cur && ratio[i] >= onThresh) cur = { from: i, to: i, peakRatio: ratio[i], peakIndex: i }
    else if (cur) {
      if (ratio[i] > cur.peakRatio) { cur.peakRatio = ratio[i]; cur.peakIndex = i }
      if (ratio[i] <= offThresh) { cur.to = i; triggers.push(cur); cur = null }
    }
  }
  if (cur) { cur.to = n - 1; triggers.push(cur) }
  return { ratio, triggers }
}

// ───────────────────────── CUSUM change-point ─────────────────────────

export interface CusumResult {
  splus: number[]
  sminus: number[]
  /** Indices where |CUSUM| first crossed H (the detected change-points); the accumulator resets after. */
  alarms: number[]
}

/** Page's (1954) two-sided CUSUM for a shift in mean away from `target`. K = allowance/slack
 *  (typically 0.5σ — a shift smaller than K is ignored), H = decision interval (typically 4–5σ).
 *  Sᵢ⁺ = max(0, Sᵢ₋₁⁺ + (xᵢ − target − K)); Sᵢ⁻ = max(0, Sᵢ₋₁⁻ − (xᵢ − target + K)). */
export function cusum(xs: readonly number[], target: number, K: number, H: number): CusumResult {
  const n = xs.length
  const splus = new Array<number>(n).fill(0)
  const sminus = new Array<number>(n).fill(0)
  const alarms: number[] = []
  let sp = 0, sm = 0
  for (let i = 0; i < n; i++) {
    sp = Math.max(0, sp + (xs[i] - target - K))
    sm = Math.max(0, sm - (xs[i] - target + K))
    splus[i] = sp
    sminus[i] = sm
    if (sp >= H || sm >= H) { alarms.push(i); sp = 0; sm = 0 }
  }
  return { splus, sminus, alarms }
}

// ───────────────────────── PELT changepoint segmentation ─────────────────────────

/** Robust noise-scale estimate from FIRST DIFFERENCES (Donoho's wavelet-shrinkage estimator):
 *  for iid noise, sd(xᵢ₊₁ − xᵢ) = σ√2, so σ̂ = 1.4826·MAD(diff)/√2. Signal steps land in the MAD's
 *  discarded tail, so a series with genuine level shifts still yields the NOISE scale, not the
 *  shift scale. When MAD(diff) collapses to 0 — which is the NORMAL case for our zero-inflated
 *  cost series (>50% quiet minutes ⇒ >50% zero diffs), not an exotic edge — fall back to the
 *  mean-abs-dev with the √(π/2)=1.253314 normal-consistency factor (the same fallback ladder
 *  Iglewicz–Hoaglin prescribe for the modified z), because a floored σ̂≈0 would make PELT read
 *  every tiny wiggle as an infinitely confident changepoint and shatter the series. 0 only for
 *  n < 2 or a truly noise-free series. */
export function robustNoiseSigma(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const diffs: number[] = []
  for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i - 1])
  const med = median(diffs)
  const m = mad(diffs, med)
  const ma = meanAbsDev(diffs, med)
  // Collapse detection must be RELATIVE, not `m > 0`: when the majority of diffs are identical the
  // true MAD is 0, but float residue (e.g. 4.8−5.2 = −0.40000000000000036) leaves m ≈ 1e-16 — and a
  // 1e-16 scale makes every wiggle an infinitely confident changepoint. For a healthy distribution
  // MAD and meanAD are the same order (Normal: MAD ≈ 0.674·meanAD·√(π/2)); a collapsed MAD sits
  // orders of magnitude below meanAD, so the 1e-8 relative gate cleanly separates the two regimes.
  if (m > 1e-8 * ma) return (1.4826 * m) / Math.SQRT2
  return (1.253314 * ma) / Math.SQRT2
}

export interface PeltSegment {
  /** Inclusive bucket-index bounds. */
  from: number
  to: number
  mean: number
}

export interface PeltResult {
  /** First index of each NEW segment after a change (empty = homogeneous series). */
  changepoints: number[]
  segments: PeltSegment[]
}

/** PELT — Pruned Exact Linear Time changepoint detection (Killick, Fearnhead & Eckley 2012, JASA).
 *  Exact minimizer of Σ segRSS/σ̂² + β·(#changepoints) for a change-in-mean model; the pruning step
 *  (valid with K=0 for the RSS cost class) keeps it near-linear. Default penalty β = 2·ln n (BIC).
 *  σ̂ from {@link robustNoiseSigma}, floored so a noise-free step series still splits (RSS>0 vs
 *  σ̂=0 must read as an infinitely confident change, not 0/0). */
export function pelt(xs: readonly number[], opts?: { penalty?: number }): PeltResult {
  const n = xs.length
  if (n === 0) return { changepoints: [], segments: [] }
  const beta = opts?.penalty ?? 2 * Math.log(Math.max(2, n))
  const sigma = robustNoiseSigma(xs)
  const sigma2 = Math.max(sigma * sigma, 1e-12)

  // Prefix sums → O(1) segment RSS: rss[a,b) = ΣX² − (ΣX)²/len.
  const S1 = new Array<number>(n + 1).fill(0)
  const S2 = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) { S1[i + 1] = S1[i] + xs[i]; S2[i + 1] = S2[i] + xs[i] * xs[i] }
  const cost = (a: number, b: number): number => {
    const len = b - a
    const sum = S1[b] - S1[a]
    const rss = Math.max(0, S2[b] - S2[a] - (sum * sum) / len)
    return rss / sigma2
  }

  // F[t] = optimal penalized cost of x[0,t); last[t] = start of the final segment in that optimum.
  const F = new Array<number>(n + 1).fill(0)
  const last = new Array<number>(n + 1).fill(0)
  F[0] = -beta
  let candidates = [0]
  for (let t = 1; t <= n; t++) {
    let best = Infinity
    let bestTau = 0
    for (const tau of candidates) {
      const v = F[tau] + cost(tau, t) + beta
      if (v < best) { best = v; bestTau = tau }
    }
    F[t] = best
    last[t] = bestTau
    // PELT pruning: a τ that cannot beat F[t] now can never beat it later (K=0 for RSS).
    candidates = candidates.filter(tau => F[tau] + cost(tau, t) <= F[t])
    candidates.push(t)
  }

  // Backtrack the segment starts.
  const starts: number[] = []
  for (let t = n; t > 0; t = last[t]) starts.push(last[t])
  starts.reverse()
  const segments: PeltSegment[] = starts.map((s, i) => {
    const e = (i + 1 < starts.length ? starts[i + 1] : n) - 1
    return { from: s, to: e, mean: (S1[e + 1] - S1[s]) / (e - s + 1) }
  })
  return { changepoints: starts.slice(1), segments }
}

// ───────────────────────── magnitude (Gutenberg–Richter analog) ─────────────────────────

/** Event "magnitude" on a log scale (Gutenberg–Richter analogue): M = log₁₀(energy / reference).
 *  `energy` is the event's released cost/activity; `reference` is the baseline per-bucket level.
 *  Returns 0 for energy ≤ reference (no excess). Gives a compressed, comparable ranking of events. */
export function magnitude(energy: number, reference: number): number {
  if (reference <= 0 || energy <= reference) return 0
  return Math.log10(energy / reference)
}
