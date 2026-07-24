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
//   • CFAR local background — Finn & Johnson (CA-CFAR, RCA Rev. 29, 1968) with GUARD cells and the
//     trimmed-mean variant for a NON-HOMOGENEOUS background (Gandhi & Kassam, IEEE T-AES 24(4),
//     1988; cf. Rohling's OS-CFAR, IEEE T-AES 19(4), 1983). Estimates the background LOCALLY around
//     each cell so a slowly-varying (day/night) level cannot be mistaken for an anomaly.

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

// ───────────────────────── CFAR local background (nonstationary null) ─────────────────────────

export interface CfarOptions {
  /** Reference cells per side (leading AND lagging). 0 disables (every cell returns null). */
  reference: number
  /** Guard cells per side, excluded from the reference sample together with the cell under test.
   *  An event spills into the minutes next to its peak, and a baseline built from those cells would
   *  be raised by the very anomaly it is supposed to detect (CFAR self-masking). */
  guard: number
  /** Fraction trimmed from EACH tail before the mean (TM-CFAR). The upper trim is what makes the
   *  estimate survive an interfering event INSIDE the reference window; contamination beyond this
   *  fraction starts to raise the local level. Default 0.25. */
  trim?: number
  /** Minimum usable reference cells; below it the cell yields null so the CALLER can fall back to a
   *  global estimate rather than trust a 3-sample background (series edges, sparse masks). Default 30. */
  minReference?: number
  /** Optional mask: only cells with include[j] === true enter the reference sample (e.g. ACTIVE
   *  buckets for a hurdle model). */
  include?: readonly boolean[]
}

export interface CfarCell {
  /** Usable reference cells behind this estimate (after guard + mask + edge truncation). */
  n: number
  /** Trimmed mean of the reference sample — the local background LEVEL (TM-CFAR). */
  trimmedMean: number
  /** WINSORIZED variance of the same sample (Tukey; the standard scale companion to a trimmed
   *  mean — cf. Yuen 1974): the trimmed tails are CAPPED at the boundary values instead of dropped,
   *  so a burst inside the window cannot inflate it while the estimate keeps all n cells and avoids
   *  the systematic shrinkage that dropping them causes. This is what measures the background's
   *  OVER-DISPERSION (variance ≫ mean ⇒ counts are not Poisson). */
  winsorVar: number
  /** Robust location/scale of the same sample (median/MAD/meanAD/σ̂) for a robust local z. */
  baseline: RobustBaseline
}

/** Per-cell LOCAL background estimate — the CFAR family (Finn & Johnson 1968; trimmed-mean variant
 *  Gandhi & Kassam 1988). For each index the reference sample is the cells at offsets d with
 *  `guard < |d| ≤ guard + reference`, so the cell under test and its guard band never contribute.
 *
 *  Why this exists: a GLOBAL median/λ̂ asserts a STATIONARY background. A real activity series is
 *  not stationary (day/night, work-session regimes), and under one global level every busy-but-
 *  NORMAL bucket reads as an anomaly — the measured false-alarm rate then sits far above α no
 *  matter how exact the tail probabilities are. A local background restores the constant-false-
 *  alarm property the whole detector depends on.
 *
 *  Known limit (documented, not hidden): an event lasting longer than `trim`·(reference cells) —
 *  or than the median's 50% breakdown for the robust baseline — partially sets its own background
 *  and is attenuated. Widen `reference` (or rely on the changepoint segmentation, which is
 *  independent of this estimate) for regime-scale events. */
export function cfarLocalStats(xs: readonly number[], o: CfarOptions): (CfarCell | null)[] {
  const n = xs.length
  const R = Math.max(0, Math.floor(o.reference))
  const G = Math.max(0, Math.floor(o.guard))
  const trim = Math.min(0.49, Math.max(0, o.trim ?? 0.25))
  const minRef = Math.max(1, Math.floor(o.minReference ?? 30))
  const out = new Array<CfarCell | null>(n).fill(null)
  if (R === 0) return out
  for (let i = 0; i < n; i++) {
    const sample: number[] = []
    for (let d = -(G + R); d <= G + R; d++) {
      if (Math.abs(d) <= G) continue // the cell under test + its guard band
      const j = i + d
      if (j < 0 || j >= n) continue
      if (o.include && !o.include[j]) continue
      sample.push(xs[j])
    }
    if (sample.length < minRef) continue // caller falls back to the global estimate
    const s = sample.sort((a, b) => a - b)
    // Keep at least one element even for a tiny sample: k is capped at ⌊(n−1)/2⌋.
    const k = Math.min(Math.floor(s.length * trim), Math.floor((s.length - 1) / 2))
    let sum = 0
    for (let t = k; t < s.length - k; t++) sum += s[t]
    // Winsorized scale: clamp to the trim boundaries (s is sorted, so clamping ≡ replacing the
    // dropped tails with the boundary order statistics), then the usual mean/variance over all n.
    const lo = s[k], hi = s[s.length - 1 - k]
    let wsum = 0
    for (let t = 0; t < s.length; t++) wsum += Math.min(hi, Math.max(lo, s[t]))
    const winMean = wsum / s.length
    let wss = 0
    for (let t = 0; t < s.length; t++) {
      const d = Math.min(hi, Math.max(lo, s[t])) - winMean
      wss += d * d
    }
    out[i] = {
      n: s.length, trimmedMean: sum / (s.length - 2 * k),
      winsorVar: s.length > 1 ? wss / (s.length - 1) : 0,
      baseline: robustBaseline(s),
    }
  }
  return out
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

/** Negative-binomial (Poisson–Gamma mixture) upper tail P(X ≥ k | mean, variance) — the OVER-DISPERSED
 *  count law. Real arrival counts are almost never Poisson: turns arrive in CLUSTERS (one action
 *  triggers a burst; sessions start and stop), so variance ≫ mean and a Poisson tail declares
 *  ordinary busy minutes improbable — measured on live fleet data as a 13.5% background
 *  false-alarm share where 5% was expected. The NB adds exactly one parameter for that excess
 *  variance and CONTAINS Poisson as its limiting case (variance → mean ⇒ r → ∞), so using it can
 *  only remove false alarms, never manufacture significance.
 *
 *  Method-of-moments parameterization (Cameron & Trivedi, *Regression Analysis of Count Data*):
 *  success probability p = μ/σ², size r = μ²/(σ²−μ); pmf(i) = Γ(i+r)/(Γ(r)·i!)·p^r·(1−p)^i, summed
 *  in log-space through {@link lgamma}. Falls back to the exact Poisson tail when the sample is NOT
 *  over-dispersed (σ² ≤ μ) — under-dispersion is not evidence for a wider law. */
export function negBinomSF(k: number, mean: number, variance: number): number {
  if (k <= 0) return 1
  if (!(mean > 0)) return 0
  if (!(variance > mean)) return poissonSF(k, mean)
  const r = (mean * mean) / (variance - mean)
  const p = mean / variance
  const lnP = Math.log(p)
  const ln1mP = Math.log1p(-p)
  const lgR = lgamma(r)
  let cdf = 0 // Σ_{i=0}^{k−1} pmf(i)
  for (let i = 0; i < k; i++) cdf += Math.exp(lgamma(i + r) - lgR - lgamma(i + 1) + r * lnP + i * ln1mP)
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

// ───────────────────────── null-share estimation (calibration honesty) ─────────────────────────

/** Storey's (2002, JRSS-B 64(3)) π₀ — the estimated proportion of TRUE NULLS among a set of
 *  p-values: π̂₀ = #{p > λ} / ((1−λ)·m), conventionally at λ = 0.5. Under H₀ p-values are uniform,
 *  so half of the nulls land above 0.5; anomalies land near 0 and barely touch that half.
 *
 *  Why the burn report needs it: "share of background buckets with p < 0.05" is NOT a calibration
 *  measure when real anomalies are present — a MORE sensitive detector finds more true anomalies
 *  that miss the strict FDR bar, so the share RISES as the null improves. π̂₀ separates the two:
 *  the null-attributable part of that share is α·π̂₀, and the remainder is signal.
 *  Clamped to (0,1]; sampling noise can push the raw ratio slightly above 1 when there is no signal. */
export function storeyPi0(pvalues: readonly number[], lambda = 0.5): number {
  const m = pvalues.length
  if (m === 0 || !(lambda > 0 && lambda < 1)) return 1
  const above = pvalues.filter(p => p > lambda).length
  return Math.min(1, Math.max(1 / m, above / ((1 - lambda) * m)))
}

/** Uniformity of the UPPER half of a p-value histogram: max(bin)/min(bin) over the bins above 0.5.
 *  Signal lives near 0 and cannot bend this half, so a ratio near 1 means the null is well
 *  specified while a large ratio is direct evidence of MIS-specification (or of discreteness, which
 *  is conservative and shows as a pile in the TOP bin). 1 for an empty/degenerate sample. */
export function upperTailUniformity(pvalues: readonly number[], bins = 10): number {
  const half = Math.floor(bins / 2)
  const h = new Array<number>(bins).fill(0)
  for (const p of pvalues) h[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))]++
  const upper = h.slice(half)
  const min = Math.min(...upper)
  const max = Math.max(...upper)
  if (max === 0) return 1
  return max / Math.max(1, min)
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
