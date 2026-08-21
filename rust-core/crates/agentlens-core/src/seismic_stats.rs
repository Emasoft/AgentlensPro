//! Port of `src/seismicStats.ts` (TRDD-DMWOBWFH P4x.2r) — the statistical primitives the burn-event
//! ("seismic") analysis is built from. Pure math, no I/O.
//!
//! The problem these solve: a "burn" is a rare, large deviation in a per-minute cost series, and
//! detecting it with the naive mean ± k·σ is WRONG — the outliers being detected corrupt the very
//! mean and σ used to detect them (the masking effect). Every primitive here is a NAMED, published
//! method chosen for a proven property, and the TS side is unit-tested against textbook constants,
//! so the parity oracle inherits that grounding rather than re-deriving it.
//!
//! Citations are kept from the TS because they are the specification: MAD + Iglewicz-Hoaglin
//! modified z (1993); Poisson / negative-binomial exceedance; Benjamini-Hochberg (1995) and
//! Benjamini-Yekutieli (2001) FDR; STA/LTA (Allen 1978); CUSUM (Page 1954); PELT (Killick et al.
//! 2012); CFAR with guard cells and a trimmed mean (Finn & Johnson 1968; Gandhi & Kassam 1988);
//! Lanczos lgamma; Storey (2002) π₀.

use std::cmp::Ordering;

fn asc(a: &f64, b: &f64) -> Ordering {
    a.partial_cmp(b).unwrap_or(Ordering::Equal)
}

/// Median of a sample (average of the two middle order statistics for even n). NaN for empty.
pub fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut s = xs.to_vec();
    s.sort_by(asc);
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

/// Median Absolute Deviation: median(|xᵢ − med|). Robust scale, 50% breakdown point.
pub fn mad(xs: &[f64], med: f64) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let devs: Vec<f64> = xs.iter().map(|x| (x - med).abs()).collect();
    median(&devs)
}

/// Mean absolute deviation about the median — the fallback scale when MAD collapses to 0
/// (Iglewicz-Hoaglin: many tied values).
pub fn mean_abs_dev(xs: &[f64], med: f64) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    xs.iter().map(|x| (x - med).abs()).sum::<f64>() / xs.len() as f64
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RobustBaseline {
    pub median: f64,
    pub mad: f64,
    pub mean_ad: f64,
    /// Normal-consistent robust σ estimate = 1.4826·MAD.
    pub sigma_hat: f64,
}

pub fn robust_baseline(xs: &[f64]) -> RobustBaseline {
    let med = median(xs);
    let m = mad(xs, med);
    RobustBaseline { median: med, mad: m, mean_ad: mean_abs_dev(xs, med), sigma_hat: 1.4826 * m }
}

/// Iglewicz-Hoaglin (1993) modified z-score. |M| > 3.5 ⇒ outlier. 0.6745 = Φ⁻¹(0.75) = 1/1.4826.
///
/// The collapse gate is RELATIVE, and that is load-bearing: a majority of identical values leaves
/// MAD ≈ 1e-16 of float residue rather than exactly 0, and dividing by a residue scale turns every
/// point into a fake extreme outlier.
pub fn modified_z(x: f64, med: f64, madv: f64, mean_ad: f64) -> f64 {
    if madv > 1e-8 * mean_ad && madv > 0.0 {
        return (0.6745 * (x - med)) / madv;
    }
    if mean_ad > 0.0 {
        return (x - med) / (1.253_314 * mean_ad);
    }
    0.0
}

pub fn modified_z_scores(xs: &[f64], b: Option<RobustBaseline>) -> Vec<f64> {
    let b = b.unwrap_or_else(|| robust_baseline(xs));
    xs.iter().map(|x| modified_z(*x, b.median, b.mad, b.mean_ad)).collect()
}

pub struct CfarOptions<'a> {
    /// Reference cells per side (leading AND lagging). 0 disables (every cell returns None).
    pub reference: f64,
    /// Guard cells per side, excluded together with the cell under test. An event spills into the
    /// minutes next to its peak, and a baseline built from those cells would be raised by the very
    /// anomaly it is meant to detect (CFAR self-masking).
    pub guard: f64,
    /// Fraction trimmed from EACH tail before the mean (TM-CFAR). Default 0.25.
    pub trim: Option<f64>,
    /// Minimum usable reference cells; below it the cell yields None so the CALLER can fall back to
    /// a global estimate rather than trust a 3-sample background. Default 30.
    pub min_reference: Option<f64>,
    /// Optional mask: only cells with `include[j]` enter the reference sample.
    pub include: Option<&'a [bool]>,
}

#[derive(Clone, Copy, Debug)]
pub struct CfarCell {
    pub n: usize,
    pub trimmed_mean: f64,
    /// WINSORIZED variance of the same sample (Tukey; the scale companion to a trimmed mean): the
    /// trimmed tails are CAPPED at the boundary values instead of dropped, so a burst inside the
    /// window cannot inflate it while the estimate keeps all n cells. This is what measures the
    /// background's OVER-DISPERSION (variance ≫ mean ⇒ counts are not Poisson).
    pub winsor_var: f64,
    pub baseline: RobustBaseline,
}

/// Per-cell LOCAL background estimate. A GLOBAL median asserts a STATIONARY background; a real
/// activity series is not stationary (day/night, session regimes), and under one global level every
/// busy-but-NORMAL bucket reads as an anomaly no matter how exact the tail probabilities are.
pub fn cfar_local_stats(xs: &[f64], o: &CfarOptions<'_>) -> Vec<Option<CfarCell>> {
    let n = xs.len();
    let r = o.reference.max(0.0).floor() as i64;
    let g = o.guard.max(0.0).floor() as i64;
    let trim = o.trim.unwrap_or(0.25).clamp(0.0, 0.49);
    let min_ref = o.min_reference.unwrap_or(30.0).floor().max(1.0) as usize;
    let mut out: Vec<Option<CfarCell>> = vec![None; n];
    if r == 0 {
        return out;
    }
    for (i, slot) in out.iter_mut().enumerate() {
        let mut sample: Vec<f64> = Vec::new();
        for d in -(g + r)..=(g + r) {
            if d.abs() <= g {
                continue; // the cell under test + its guard band
            }
            let j = i as i64 + d;
            if j < 0 || j >= n as i64 {
                continue;
            }
            let j = j as usize;
            if o.include.is_some_and(|inc| !inc[j]) {
                continue;
            }
            sample.push(xs[j]);
        }
        if sample.len() < min_ref {
            continue; // caller falls back to the global estimate
        }
        sample.sort_by(asc);
        let s = &sample;
        // Keep at least one element even for a tiny sample: k is capped at ⌊(n−1)/2⌋.
        let k = ((s.len() as f64 * trim).floor() as usize).min((s.len() - 1) / 2);
        let sum: f64 = s[k..s.len() - k].iter().sum();
        let (lo, hi) = (s[k], s[s.len() - 1 - k]);
        let wins: Vec<f64> = s.iter().map(|v| v.min(hi).max(lo)).collect();
        let win_mean = wins.iter().sum::<f64>() / s.len() as f64;
        let wss: f64 = wins.iter().map(|w| (w - win_mean) * (w - win_mean)).sum();
        *slot = Some(CfarCell {
            n: s.len(),
            trimmed_mean: sum / (s.len() - 2 * k) as f64,
            winsor_var: if s.len() > 1 { wss / (s.len() - 1) as f64 } else { 0.0 },
            baseline: robust_baseline(s),
        });
    }
    out
}

const LANCZOS_G: usize = 7;
// Copied VERBATIM from the published g=7 coefficient set (and from the TS). Clippy is right that
// four of them carry more digits than an f64 holds — and truncating to the shortest round-trip form
// would produce the same bits while breaking the correspondence with the source they are cited
// from, which is the only way a reader can check them. Kept literal; the allow is the smaller cost.
#[allow(clippy::excessive_precision)]
const LANCZOS_C: [f64; 9] = [
    0.999_999_999_999_809_93,
    676.520_368_121_885_1,
    -1_259.139_216_722_402_8,
    771.323_428_777_653_13,
    -176.615_029_162_140_59,
    12.507_343_278_686_905,
    -0.138_571_095_265_720_12,
    9.984_369_578_019_571_6e-6,
    1.505_632_735_149_311_6e-7,
];

/// log Γ(z) via the Lanczos approximation (g=7, 9 coefficients). Accurate to ~1e-13 for z>0.
pub fn lgamma(z: f64) -> f64 {
    if z < 0.5 {
        // Reflection formula Γ(z)Γ(1−z) = π/sin(πz) extends it below 0.5.
        return (std::f64::consts::PI / (std::f64::consts::PI * z).sin()).abs().ln() - lgamma(1.0 - z);
    }
    let z = z - 1.0;
    let mut a = LANCZOS_C[0];
    let t = z + LANCZOS_G as f64 + 0.5;
    for (i, c) in LANCZOS_C.iter().enumerate().take(LANCZOS_G + 2).skip(1) {
        a += c / (z + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (z + 0.5) * t.ln() - t + a.ln()
}

/// Poisson upper-tail exceedance P(X ≥ k | λ), summed in log-space via lgamma for stability.
pub fn poisson_sf(k: f64, lambda: f64) -> f64 {
    if k <= 0.0 {
        return 1.0;
    }
    if lambda <= 0.0 {
        return 0.0;
    }
    let ln_l = lambda.ln();
    let mut cdf = 0.0;
    let mut i = 0.0;
    while i < k {
        cdf += (i * ln_l - lambda - lgamma(i + 1.0)).exp();
        i += 1.0;
    }
    (1.0 - cdf).clamp(0.0, 1.0)
}

/// Negative-binomial (Poisson-Gamma mixture) upper tail — the OVER-DISPERSED count law.
///
/// Real arrival counts are almost never Poisson: turns arrive in CLUSTERS, so variance ≫ mean and a
/// Poisson tail declares ordinary busy minutes improbable (measured on live fleet data as a 13.5%
/// background false-alarm share where 5% was expected). The NB adds exactly one parameter for that
/// excess variance and CONTAINS Poisson as its limit, so using it can only remove false alarms,
/// never manufacture significance. Falls back to the exact Poisson tail when the sample is NOT
/// over-dispersed — under-dispersion is not evidence for a wider law.
// `!(mean > 0.0)` is NOT a clumsy `<=`: it is the JS guard, and the difference is NaN. `NaN <= 0`
// is FALSE, so the "fixed" form would sail past a NaN mean into a log of NaN and return a NaN
// p-value — a p-value that is neither significant nor insignificant, silently poisoning the FDR
// step-up. The negated form rejects NaN, which is the whole point.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn neg_binom_sf(k: f64, mean: f64, variance: f64) -> f64 {
    if k <= 0.0 {
        return 1.0;
    }
    if !(mean > 0.0) {
        return 0.0;
    }
    if !(variance > mean) {
        return poisson_sf(k, mean);
    }
    let r = (mean * mean) / (variance - mean);
    let p = mean / variance;
    let ln_p = p.ln();
    let ln1m_p = (-p).ln_1p();
    let lg_r = lgamma(r);
    let mut cdf = 0.0;
    let mut i = 0.0;
    while i < k {
        cdf += (lgamma(i + r) - lg_r - lgamma(i + 1.0) + r * ln_p + i * ln1m_p).exp();
        i += 1.0;
    }
    (1.0 - cdf).clamp(0.0, 1.0)
}

// Abramowitz & Stegun 7.1.26 rational approximation of erf (|error| ≤ 1.5e-7).
const ERF_P: f64 = 0.327_591_1;
const ERF_A: [f64; 5] = [0.254_829_592, -0.284_496_736, 1.421_413_741, -1.453_152_027, 1.061_405_429];

pub fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs();
    let t = 1.0 / (1.0 + ERF_P * ax);
    let poly = ((((ERF_A[4] * t + ERF_A[3]) * t + ERF_A[2]) * t + ERF_A[1]) * t + ERF_A[0]) * t;
    sign * (1.0 - poly * (-ax * ax).exp())
}

pub fn normal_cdf(z: f64) -> f64 {
    0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2))
}

/// Standard-normal upper-tail survival 1 − Φ(z) — the one-sided p-value of a robust z-score.
pub fn normal_sf(z: f64) -> f64 {
    (1.0 - normal_cdf(z)).clamp(0.0, 1.0)
}

/// χ² survival for EXACTLY 4 degrees of freedom — the null of Fisher's method over two p-values.
/// Closed form (Erlang-2 tail): SF(x) = e^(−x/2)·(1 + x/2). No approximation.
// Same NaN reasoning as `neg_binom_sf`: `!(x > 0.0)` returns 1 for NaN, where `x <= 0.0` would fall
// through and return NaN.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn chi_squared_sf4(x: f64) -> f64 {
    if !(x > 0.0) {
        return 1.0;
    }
    if !x.is_finite() {
        return 0.0;
    }
    (-x / 2.0).exp() * (1.0 + x / 2.0)
}

/// Fisher's method (1932) for TWO independent p-values: X = −2(ln p₁ + ln p₂) ~ χ²₄ under H₀. Here
/// p₁ is the Poisson RATE test and p₂ the lognormal INTENSITY test — independent by Poisson thinning
/// (arrival counts ⊥ per-arrival marks). A p ≤ 0 is infinitely strong evidence (combined 0).
pub fn fisher_combine(p1: f64, p2: f64) -> f64 {
    let a = p1.min(1.0);
    let b = p2.min(1.0);
    if a <= 0.0 || b <= 0.0 {
        return 0.0;
    }
    chi_squared_sf4(-2.0 * (a.ln() + b.ln()))
}

#[derive(Clone, Debug, Default)]
pub struct BhResult {
    pub rejected: Vec<bool>,
    /// The BH critical p-value (largest p still rejected); 0 if nothing is significant.
    pub threshold: f64,
    pub n_rejected: usize,
}

/// Benjamini-Hochberg (1995) step-up FDR control at level α — the multiple-comparison correction
/// that turns "z>2 on 480 buckets" (≈24 expected false alarms) into a defensible anomaly set.
pub fn benjamini_hochberg(pvalues: &[f64], alpha: f64) -> BhResult {
    let m = pvalues.len();
    let mut rejected = vec![false; m];
    if m == 0 {
        return BhResult { rejected, threshold: 0.0, n_rejected: 0 };
    }
    let mut order: Vec<(f64, usize)> = pvalues.iter().copied().zip(0..).collect();
    // STABLE, like JS's sort since ES2019: equal p-values keep their original index order, and the
    // rejected SET is what that decides at the cut.
    order.sort_by(|a, b| asc(&a.0, &b.0));
    let mut k_max: i64 = -1;
    for (rank, item) in order.iter().enumerate() {
        if item.0 <= ((rank + 1) as f64 / m as f64) * alpha {
            k_max = rank as i64;
        }
    }
    for item in order.iter().take((k_max + 1).max(0) as usize) {
        rejected[item.1] = true;
    }
    BhResult {
        rejected,
        threshold: if k_max >= 0 { ((k_max + 1) as f64 / m as f64) * alpha } else { 0.0 },
        n_rejected: (k_max + 1).max(0) as usize,
    }
}

/// Benjamini-Yekutieli (2001): BH run at level α/H(m). Controls FDR ≤ α under ARBITRARY dependence
/// between the tests, which BH alone does not — conservative by the factor H(m) (~ln m).
pub fn benjamini_yekutieli(pvalues: &[f64], alpha: f64) -> BhResult {
    let m = pvalues.len();
    if m == 0 {
        return BhResult { rejected: Vec::new(), threshold: 0.0, n_rejected: 0 };
    }
    let mut harmonic = 0.0;
    for i in 1..=m {
        harmonic += 1.0 / i as f64;
    }
    benjamini_hochberg(pvalues, alpha / harmonic)
}

/// Storey's (2002) π̂₀ — the estimated proportion of TRUE NULLS among a set of p-values.
///
/// Why the burn report needs it: "share of background buckets with p < 0.05" is NOT a calibration
/// measure when real anomalies are present — a MORE sensitive detector finds more true anomalies
/// that miss the strict FDR bar, so the share RISES as the null improves. π̂₀ separates the two.
pub fn storey_pi0(pvalues: &[f64], lambda: f64) -> f64 {
    let m = pvalues.len();
    if m == 0 || !(lambda > 0.0 && lambda < 1.0) {
        return 1.0;
    }
    let above = pvalues.iter().filter(|p| **p > lambda).count() as f64;
    (above / ((1.0 - lambda) * m as f64)).clamp(1.0 / m as f64, 1.0)
}

/// Uniformity of the UPPER half of a p-value histogram: max(bin)/min(bin) over the bins above 0.5.
/// Signal lives near 0 and cannot bend this half, so a ratio near 1 means the null is well specified
/// while a large ratio is direct evidence of MIS-specification.
pub fn upper_tail_uniformity(pvalues: &[f64], bins: usize) -> f64 {
    let half = bins / 2;
    let mut h = vec![0.0_f64; bins];
    for p in pvalues {
        let idx = ((p * bins as f64).floor()).clamp(0.0, (bins - 1) as f64) as usize;
        h[idx] += 1.0;
    }
    let upper = &h[half..];
    let min = upper.iter().copied().fold(f64::INFINITY, f64::min);
    let max = upper.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if max == 0.0 {
        return 1.0;
    }
    max / min.max(1.0)
}

#[derive(Clone, Copy, Debug)]
pub struct StaLtaTrigger {
    pub from: usize,
    pub to: usize,
    pub peak_ratio: f64,
    pub peak_index: usize,
}

pub struct StaLtaResult {
    pub ratio: Vec<f64>,
    pub triggers: Vec<StaLtaTrigger>,
}

/// Classic STA/LTA detector (Allen 1978): the ratio of a Short-Term to a Long-Term Average of the
/// |signal|, giving a mathematically-defined onset/offset interval rather than a hand-picked window.
pub fn sta_lta(xs: &[f64], nsta: usize, nlta: usize, on_thresh: f64, off_thresh: f64) -> StaLtaResult {
    let n = xs.len();
    let mut ratio = vec![0.0; n];
    let mut prefix = vec![0.0; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + xs[i].abs();
    }
    let avg = |i: usize, w: usize| -> f64 {
        let lo = (i + 1).saturating_sub(w);
        (prefix[i + 1] - prefix[lo]) / (i - lo + 1) as f64
    };
    for (i, r) in ratio.iter_mut().enumerate() {
        let lta = avg(i, nlta);
        *r = if lta > 0.0 { avg(i, nsta) / lta } else { 0.0 };
    }
    let mut triggers: Vec<StaLtaTrigger> = Vec::new();
    let mut cur: Option<StaLtaTrigger> = None;
    for (i, &ri) in ratio.iter().enumerate() {
        match cur.as_mut() {
            None => {
                if ri >= on_thresh {
                    cur = Some(StaLtaTrigger { from: i, to: i, peak_ratio: ri, peak_index: i });
                }
            }
            Some(c) => {
                if ri > c.peak_ratio {
                    c.peak_ratio = ri;
                    c.peak_index = i;
                }
                if ri <= off_thresh {
                    c.to = i;
                    triggers.push(*c);
                    cur = None;
                }
            }
        }
    }
    if let Some(mut c) = cur {
        c.to = n - 1;
        triggers.push(c);
    }
    StaLtaResult { ratio, triggers }
}

pub struct CusumResult {
    pub splus: Vec<f64>,
    pub sminus: Vec<f64>,
    /// Indices where |CUSUM| first crossed H; the accumulator resets after.
    pub alarms: Vec<usize>,
}

/// Page's (1954) two-sided CUSUM for a shift in mean away from `target`. K = allowance/slack
/// (typically 0.5σ), H = decision interval (typically 4–5σ).
pub fn cusum(xs: &[f64], target: f64, k: f64, h: f64) -> CusumResult {
    let n = xs.len();
    let mut splus = vec![0.0; n];
    let mut sminus = vec![0.0; n];
    let mut alarms = Vec::new();
    let (mut sp, mut sm) = (0.0_f64, 0.0_f64);
    for i in 0..n {
        sp = 0.0_f64.max(sp + (xs[i] - target - k));
        sm = 0.0_f64.max(sm - (xs[i] - target + k));
        splus[i] = sp;
        sminus[i] = sm;
        if sp >= h || sm >= h {
            alarms.push(i);
            sp = 0.0;
            sm = 0.0;
        }
    }
    CusumResult { splus, sminus, alarms }
}

/// Robust noise-scale from FIRST DIFFERENCES (Donoho): for iid noise sd(xᵢ₊₁ − xᵢ) = σ√2, so
/// σ̂ = 1.4826·MAD(diff)/√2. Signal steps land in the MAD's discarded tail, so a series with genuine
/// level shifts still yields the NOISE scale.
///
/// The collapse fallback is the NORMAL case here, not an exotic edge: a zero-inflated cost series
/// (>50% quiet minutes ⇒ >50% zero diffs) collapses MAD to float residue, and a residue-scale σ̂
/// would make PELT read every wiggle as an infinitely confident changepoint and shatter the series.
pub fn robust_noise_sigma(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let diffs: Vec<f64> = xs.windows(2).map(|w| w[1] - w[0]).collect();
    let med = median(&diffs);
    let m = mad(&diffs, med);
    let ma = mean_abs_dev(&diffs, med);
    if m > 1e-8 * ma {
        return (1.4826 * m) / std::f64::consts::SQRT_2;
    }
    (1.253_314 * ma) / std::f64::consts::SQRT_2
}

#[derive(Clone, Copy, Debug)]
pub struct PeltSegment {
    pub from: usize,
    pub to: usize,
    pub mean: f64,
}

pub struct PeltResult {
    /// First index of each NEW segment after a change (empty = homogeneous series).
    pub changepoints: Vec<usize>,
    pub segments: Vec<PeltSegment>,
}

/// PELT — Pruned Exact Linear Time changepoint detection (Killick, Fearnhead & Eckley 2012). Exact
/// minimizer of Σ segRSS/σ̂² + β·(#changepoints) for a change-in-mean model. Default β = 2·ln n (BIC).
/// σ̂ is FLOORED so a noise-free step series still splits (RSS>0 vs σ̂=0 must read as an infinitely
/// confident change, not 0/0).
pub fn pelt(xs: &[f64], penalty: Option<f64>) -> PeltResult {
    let n = xs.len();
    if n == 0 {
        return PeltResult { changepoints: Vec::new(), segments: Vec::new() };
    }
    let beta = penalty.unwrap_or_else(|| 2.0 * (n.max(2) as f64).ln());
    let sigma = robust_noise_sigma(xs);
    let sigma2 = (sigma * sigma).max(1e-12);

    let mut s1 = vec![0.0; n + 1];
    let mut s2 = vec![0.0; n + 1];
    for i in 0..n {
        s1[i + 1] = s1[i] + xs[i];
        s2[i + 1] = s2[i] + xs[i] * xs[i];
    }
    let cost = |a: usize, b: usize| -> f64 {
        let len = (b - a) as f64;
        let sum = s1[b] - s1[a];
        let rss = (s2[b] - s2[a] - (sum * sum) / len).max(0.0);
        rss / sigma2
    };

    let mut f = vec![0.0; n + 1];
    let mut last = vec![0_usize; n + 1];
    f[0] = -beta;
    let mut candidates: Vec<usize> = vec![0];
    for t in 1..=n {
        let mut best = f64::INFINITY;
        let mut best_tau = 0;
        for &tau in &candidates {
            let v = f[tau] + cost(tau, t) + beta;
            if v < best {
                best = v;
                best_tau = tau;
            }
        }
        f[t] = best;
        last[t] = best_tau;
        // PELT pruning: a τ that cannot beat F[t] now can never beat it later (K=0 for RSS).
        candidates.retain(|&tau| f[tau] + cost(tau, t) <= f[t]);
        candidates.push(t);
    }

    let mut starts: Vec<usize> = Vec::new();
    let mut t = n;
    while t > 0 {
        starts.push(last[t]);
        t = last[t];
    }
    starts.reverse();
    let segments: Vec<PeltSegment> = starts
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let e = starts.get(i + 1).copied().unwrap_or(n) - 1;
            PeltSegment { from: s, to: e, mean: (s1[e + 1] - s1[s]) / (e - s + 1) as f64 }
        })
        .collect();
    PeltResult { changepoints: starts[1.min(starts.len())..].to_vec(), segments }
}

/// Event "magnitude" on a log scale (Gutenberg-Richter analogue): M = log₁₀(energy / reference).
/// 0 for energy ≤ reference (no excess).
pub fn magnitude(energy: f64, reference: f64) -> f64 {
    if reference <= 0.0 || energy <= reference {
        return 0.0;
    }
    (energy / reference).log10()
}
