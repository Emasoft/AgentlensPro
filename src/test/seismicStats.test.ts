// seismicStats — every primitive asserted against a HAND-COMPUTED textbook value, so the burn
// analysis' math is provable, not asserted. Constants come from the cited sources, not from the code.
import * as assert from 'assert'
import {
  median, mad, meanAbsDev, robustBaseline, modifiedZ, modifiedZScores,
  lgamma, poissonSF, benjaminiHochberg, benjaminiYekutieli, staLta, cusum, magnitude,
  erf, normalCdf, normalSf, chiSquaredSF4, fisherCombine, robustNoiseSigma, pelt, cfarLocalStats,
  negBinomSF, storeyPi0, upperTailUniformity,
} from '../seismicStats'

const close = (a: number, b: number, eps = 1e-9): void =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (Δ=${Math.abs(a - b)})`)

suite('seismicStats — robust location/scale', () => {
  test('median: odd = middle, even = mean of the two middles', () => {
    close(median([3, 1, 2, 5, 4]), 3)
    close(median([1, 2, 3, 4]), 2.5)
    assert.ok(Number.isNaN(median([])))
  })
  test('MAD([1..5]) = 1 (deviations [2,1,0,1,2] → median 1); σ̂ = 1.4826·MAD', () => {
    close(mad([1, 2, 3, 4, 5]), 1)
    close(robustBaseline([1, 2, 3, 4, 5]).sigmaHat, 1.4826)
  })
  test('Iglewicz–Hoaglin modified z: 0.6745·(x−med)/MAD; x=10,med=3,MAD=1 ⇒ 4.7215', () => {
    close(modifiedZ(10, 3, 1, 0), 0.6745 * 7)
    // a lone spike is flagged (|M|>3.5) while the bulk is not — the whole point of a robust score.
    const zs = modifiedZScores([1, 1, 1, 1, 1, 1, 1, 50])
    assert.ok(zs[7] > 3.5, `spike z=${zs[7]} must exceed 3.5`)
    assert.ok(zs.slice(0, 7).every(z => Math.abs(z) <= 3.5))
  })
  test('MAD=0 fallback uses mean-abs-dev with √(π/2)=1.253314', () => {
    // [5,5,5,5,9]: median 5, MAD 0, meanAD = (0+0+0+0+4)/5 = 0.8 → M(9) = 4/(1.253314·0.8)
    const ma = meanAbsDev([5, 5, 5, 5, 9])
    close(ma, 0.8)
    close(modifiedZ(9, 5, 0, ma), 4 / (1.253314 * 0.8))
  })
})

suite('seismicStats — Poisson tail & lgamma', () => {
  test('lgamma matches ln(Γ): lgamma(1)=0, lgamma(5)=ln 24, lgamma(0.5)=ln√π', () => {
    close(lgamma(1), 0, 1e-10)
    close(lgamma(5), Math.log(24), 1e-9)
    close(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9)
  })
  test('Poisson exceedance: P(X≥1|1)=1−e⁻¹; P(X≥3|1)=1−e⁻¹(1+1+½); P(X≥0)=1', () => {
    close(poissonSF(1, 1), 1 - Math.exp(-1), 1e-12)
    close(poissonSF(3, 1), 1 - Math.exp(-1) * (1 + 1 + 0.5), 1e-12)
    close(poissonSF(0, 5), 1)
    assert.strictEqual(poissonSF(2, 0), 0) // a zero-rate process never produces ≥1 event
  })
})

suite('seismicStats — negative-binomial tail (over-dispersed counts)', () => {
  test('μ=1, σ²=2 ⇒ p=½, r=1 = the GEOMETRIC law: P(X≥2)=¼, P(X≥1)=½', () => {
    close(negBinomSF(2, 1, 2), 0.25, 1e-9)   // 1 − ½ − ¼
    close(negBinomSF(1, 1, 2), 0.5, 1e-9)
    close(negBinomSF(0, 1, 2), 1)
  })
  test('μ=2, σ²=4 ⇒ p=½, r=2: pmf(0)=pmf(1)=¼ ⇒ P(X≥2)=½', () => {
    close(negBinomSF(2, 2, 4), 0.5, 1e-9)
  })
  test('CONTAINS Poisson: σ²=μ falls back exactly, and σ²→μ⁺ converges to it', () => {
    close(negBinomSF(3, 1, 1), poissonSF(3, 1), 1e-12)   // not over-dispersed → the Poisson tail
    close(negBinomSF(3, 1, 0.5), poissonSF(3, 1), 1e-12) // under-dispersion is not evidence either
    close(negBinomSF(5, 2, 2.0001), poissonSF(5, 2), 1e-3)
  })
  test('THE POINT: over-dispersion makes an ordinary busy bucket ordinary again', () => {
    // 20 turns where the local mean is 9: Poisson calls it a 1-in-950 event (p=0.001056), the NB
    // (σ²=40 — the clustered reality) calls it unremarkable. This is the live 13.5% background share.
    close(poissonSF(20, 9), 0.001056, 1e-6)
    assert.ok(negBinomSF(20, 9, 40) > 0.05, `NB p=${negBinomSF(20, 9, 40)} must not be significant`)
    // …but a REAL burst still is, under the same over-dispersed null.
    assert.ok(negBinomSF(200, 9, 40) < 1e-6, `a 200-turn burst stays significant (${negBinomSF(200, 9, 40)})`)
  })
  test('edges: k≤0 ⇒ 1; a zero-mean background yields 0 for any positive k', () => {
    close(negBinomSF(0, 5, 9), 1)
    assert.strictEqual(negBinomSF(3, 0, 1), 0)
  })
})

suite('seismicStats — standard-normal tail', () => {
  test('erf(0)=0, erf(∞)→1; Φ(0)=0.5, Φ(1)≈0.8413, Φ(1.96)≈0.975', () => {
    close(erf(0), 0)
    close(normalCdf(0), 0.5)
    close(normalCdf(1), 0.8413447, 1e-4)
    close(normalCdf(1.96), 0.9750021, 1e-3)
  })
  test('normalSf(z)=1−Φ(z): a 1.96σ upper-tail p ≈ 0.025; clamped to [0,1]', () => {
    close(normalSf(1.96), 0.0249979, 1e-3)
    close(normalSf(0), 0.5)
    assert.ok(normalSf(100) >= 0 && normalSf(-100) <= 1)
  })
})

suite('seismicStats — null-share estimation (Storey 2002) + histogram shape', () => {
  test('π̂₀: all-null (uniform) ⇒ ≈1; half the mass at 0 ⇒ ≈½; clamped to (0,1]', () => {
    const uniform = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100) // 50 above 0.5
    close(storeyPi0(uniform), 1) // 50/(0.5·100)
    // 100 p's: 50 anomalies at ~0 + 50 uniform nulls (25 of them above 0.5) ⇒ π̂₀ = 25/(0.5·100) = ½
    const mixed = [...Array(50).fill(1e-6), ...Array.from({ length: 50 }, (_, i) => (i + 0.5) / 50)]
    close(storeyPi0(mixed), 0.5)
    assert.strictEqual(storeyPi0([]), 1)
    assert.ok(storeyPi0([0.9, 0.95, 0.99]) <= 1) // raw ratio 2 → clamped
  })
  test('upper-half uniformity: flat ⇒ 1; a pile in one upper bin ⇒ large', () => {
    close(upperTailUniformity(Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100)), 1)
    // 10 in each upper bin except 50 in the last ⇒ 50/10 = 5
    const skewed = [...Array.from({ length: 50 }, (_, i) => 0.5 + (i % 5) / 10 + 0.01), ...Array(40).fill(0.95)]
    assert.ok(upperTailUniformity(skewed) > 3, `a piled top bin must show up (got ${upperTailUniformity(skewed)})`)
    assert.strictEqual(upperTailUniformity([]), 1)
  })
})

suite('seismicStats — Benjamini–Hochberg FDR', () => {
  test('all-significant ladder p=[.01..05], α=.05, m=5 → all 5 rejected, threshold .05', () => {
    const r = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05)
    assert.strictEqual(r.nRejected, 5)
    close(r.threshold, 0.05)
    assert.ok(r.rejected.every(Boolean))
  })
  test('only the tiny p survives: p=[.001,.5,.9], α=.05, m=3 → 1 rejected (index 0)', () => {
    const r = benjaminiHochberg([0.001, 0.5, 0.9], 0.05)
    assert.strictEqual(r.nRejected, 1)
    assert.deepStrictEqual(r.rejected, [true, false, false])
  })
  test('step-up (not step-down): a gap is bridged if a later rank qualifies', () => {
    // p=[.001,.04,.04], m=3, α=.05: crit ranks .0167/.0333/.05; rank3 .04≤.05 ⇒ kMax=2 ⇒ all 3.
    const r = benjaminiHochberg([0.001, 0.04, 0.04], 0.05)
    assert.strictEqual(r.nRejected, 3)
  })
})

suite('seismicStats — STA/LTA event trigger (Allen 1978)', () => {
  test('a step burst triggers ON at the rise and captures the peak', () => {
    const xs = [1, 1, 1, 1, 1, 1, 20, 20, 20, 1, 1, 1, 1, 1, 1]
    const { ratio, triggers } = staLta(xs, 1, 5, 3, 1.5)
    assert.ok(triggers.length >= 1, 'a burst must trigger at least one event')
    const t = triggers[0]
    assert.ok(t.from >= 5 && t.from <= 7, `onset near the rise (got ${t.from})`)
    assert.ok(t.peakRatio >= 3, `peak ratio ${t.peakRatio} must exceed the on-threshold`)
    assert.ok(ratio[6] > ratio[0], 'ratio rises across the burst')
  })
  test('a flat series triggers nothing', () => {
    assert.strictEqual(staLta([2, 2, 2, 2, 2, 2, 2, 2], 1, 4, 3, 1.5).triggers.length, 0)
  })
})

suite('seismicStats — CUSUM change-point (Page 1954)', () => {
  test('a sustained upward shift raises S⁺ and alarms after the shift, not before', () => {
    const xs = [0, 0, 0, 0, 0, 5, 5, 5, 5, 5]
    const r = cusum(xs, 0, 1, 3)
    assert.ok(r.alarms.length >= 1, 'the shift must alarm')
    assert.ok(r.alarms[0] >= 5, `first alarm at/after the shift index 5 (got ${r.alarms[0]})`)
    assert.strictEqual(r.splus[0], 0)
  })
  test('a stationary series at target never alarms', () => {
    assert.strictEqual(cusum([0, 0, 0, 0, 0, 0], 0, 1, 3).alarms.length, 0)
  })
})

suite('seismicStats — Fisher combined test (χ²₄ closed form)', () => {
  test('χ²₄ SF closed form: SF(0)=1, SF(2·ln4)=(1+ln4)/4, SF(∞)=0', () => {
    close(chiSquaredSF4(0), 1)
    close(chiSquaredSF4(2 * Math.log(4)), (1 + Math.log(4)) / 4) // = 0.5965736…
    close(chiSquaredSF4(Infinity), 0)
    close(chiSquaredSF4(-3), 1) // a non-positive statistic carries no evidence
  })
  test('Fisher: combine(0.5,0.5)=0.59657…; identity combine(1,p)=p·(1−ln p); edge cases', () => {
    close(fisherCombine(0.5, 0.5), (1 + Math.log(4)) / 4)
    close(fisherCombine(1, 0.05), 0.05 * (1 - Math.log(0.05))) // = 0.1997866…
    close(fisherCombine(1, 1), 1)
    close(fisherCombine(0, 0.5), 0) // p=0 is infinitely strong evidence
  })
})

suite('seismicStats — Benjamini–Yekutieli FDR (arbitrary dependence)', () => {
  test('BY = BH at α/H(m): the BH-all-rejected ladder is fully REFUSED under BY', () => {
    // H(5)=2.28333 → eff α=.021898 → largest crit .0219 < smallest p .01·(5/1)? rank-by-rank: none pass.
    const p = [0.01, 0.02, 0.03, 0.04, 0.05]
    assert.strictEqual(benjaminiHochberg(p, 0.05).nRejected, 5)
    assert.strictEqual(benjaminiYekutieli(p, 0.05).nRejected, 0)
  })
  test('BY still rejects strong evidence: [.001,.002,.5] → 2 rejected (H(3)=1.8333)', () => {
    const r = benjaminiYekutieli([0.001, 0.002, 0.5], 0.05)
    assert.strictEqual(r.nRejected, 2)
    assert.deepStrictEqual(r.rejected, [true, true, false])
  })
})

suite('seismicStats — PELT changepoint (Killick–Fearnhead–Eckley 2012)', () => {
  test('robustNoiseSigma: flat → 0; diffs [−2,−1,0,1,2] (MAD 1) → 1.4826/√2', () => {
    close(robustNoiseSigma([3, 3, 3, 3, 3]), 0)
    close(robustNoiseSigma([0, -2, -3, -3, -2, 0]), 1.4826 / Math.SQRT2)
  })
  test('MAD(diff)=0 collapse (the zero-inflated-series case) falls back to meanAD, never a 0 scale', () => {
    // Alternating ±0.2 over 24 pts: diffs = 12×(−0.4) + 11×(+0.4) → median −0.4, MAD 0 (majority
    // identical). meanAD = 11·0.8/23 → σ̂ = 1.253314·(8.8/23)/√2. A 0 here would shatter PELT.
    const xs = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2))
    close(robustNoiseSigma(xs), (1.253314 * (8.8 / 23)) / Math.SQRT2)
  })
  test('an exact step [0×10, 5×10] splits at index 10 with the true segment means', () => {
    const xs = [...Array(10).fill(0), ...Array(10).fill(5)]
    const r = pelt(xs)
    assert.deepStrictEqual(r.changepoints, [10])
    assert.deepStrictEqual(r.segments.map(s => [s.from, s.to, s.mean]), [[0, 9, 0], [10, 19, 5]])
  })
  test('a flat series has NO changepoints (the β penalty beats a free split)', () => {
    const r = pelt(Array(20).fill(3))
    assert.deepStrictEqual(r.changepoints, [])
    assert.strictEqual(r.segments.length, 1)
    close(r.segments[0].mean, 3)
  })
  test('two steps [0×8, 5×8, 1×8] recover both boundaries exactly', () => {
    const xs = [...Array(8).fill(0), ...Array(8).fill(5), ...Array(8).fill(1)]
    assert.deepStrictEqual(pelt(xs).changepoints, [8, 16])
  })
  test('a step under deterministic ±0.2 noise still splits at the true boundary', () => {
    const xs = Array.from({ length: 24 }, (_, i) => (i < 12 ? 0 : 5) + (i % 2 === 0 ? 0.2 : -0.2))
    assert.deepStrictEqual(pelt(xs).changepoints, [12])
  })
})

suite('seismicStats — CFAR local background (Finn–Johnson 1968; TM variant Gandhi–Kassam 1988)', () => {
  test('a constant series: the local level IS the constant, scale 0, n = 2·reference', () => {
    const c = cfarLocalStats(Array(50).fill(7), { reference: 10, guard: 0, minReference: 1 })
    assert.strictEqual(c[25]!.n, 20)
    close(c[25]!.trimmedMean, 7)
    close(c[25]!.baseline.median, 7)
    close(c[25]!.baseline.mad, 0)
  })
  test('GUARD cells keep an event out of its own background', () => {
    // Spikes sit immediately either side of the cell under test; guard=1 must exclude BOTH, so the
    // local level stays the background 1 (without the guard it would be (3·1+2·1000+3·1)/8 = 250.75).
    const xs = Array(20).fill(1); xs[9] = 1000; xs[11] = 1000
    const c = cfarLocalStats(xs, { reference: 3, guard: 1, trim: 0, minReference: 1 })
    close(c[10]!.trimmedMean, 1) // offsets ±2,±3,±4 → indices 6,7,8,12,13,14 — all background
  })
  test('TM-CFAR: an interfering burst inside the window is TRIMMED away', () => {
    // 40 reference cells, 4 of them contaminated at 100 (10%), trim 0.25 ⇒ the top 10 are dropped.
    const xs = Array(200).fill(1); for (let j = 90; j <= 93; j++) xs[j] = 100
    const c = cfarLocalStats(xs, { reference: 20, guard: 0, trim: 0.25, minReference: 1 })
    close(c[80]!.trimmedMean, 1)
    close(c[80]!.baseline.median, 1)
    // …and with NO trimming the same window is dragged up — the trim is what does the work.
    const raw = cfarLocalStats(xs, { reference: 20, guard: 0, trim: 0, minReference: 1 })
    close(raw[80]!.trimmedMean, (36 * 1 + 4 * 100) / 40)
  })
  test('THE POINT: on a two-regime series each cell gets ITS OWN regime, not the global mixture', () => {
    const xs = [...Array(100).fill(1), ...Array(100).fill(5)]
    const c = cfarLocalStats(xs, { reference: 20, guard: 5, trim: 0.25, minReference: 1 })
    close(c[40]!.trimmedMean, 1)  // deep in the quiet regime
    close(c[150]!.trimmedMean, 5) // deep in the busy regime
    // A single GLOBAL trimmed mean would call both 3 — half the series then looks anomalous.
    close(median(xs), 3)
  })
  test('too few reference cells ⇒ null (the caller falls back to the global estimate)', () => {
    const xs = Array(30).fill(2)
    const c = cfarLocalStats(xs, { reference: 10, guard: 0, minReference: 11 })
    assert.strictEqual(c[0], null)      // edge: only the lagging 10 cells exist
    assert.ok(c[15] !== null)           // interior: 20 cells
    assert.strictEqual(cfarLocalStats(xs, { reference: 10, guard: 0, minReference: 10 })[0]!.n, 10)
    assert.deepStrictEqual(cfarLocalStats(xs, { reference: 0, guard: 0 }), Array(30).fill(null))
  })
  test('winsorized variance: the tails are CAPPED, not dropped (fully hand-computed)', () => {
    // index 5 is the cell under test; its window is exactly the other ten: [0,1,1,2,2]+[2,3,3,4,10].
    // sorted [0,1,1,2,2,2,3,3,4,10], trim .2 ⇒ k=2 ⇒ clamp to [s₂,s₇]=[1,3] ⇒ [1,1,1,2,2,2,3,3,3,3]
    //   winsorized mean 2.1, variance = (3·1.21 + 3·0.01 + 4·0.81)/9 = 6.9/9
    //   trimmed mean = (1+2+2+2+3+3)/6 = 13/6
    const xs = [0, 1, 1, 2, 2, /* CUT */ 99, 2, 3, 3, 4, 10]
    const c = cfarLocalStats(xs, { reference: 5, guard: 0, trim: 0.2, minReference: 10 })[5]!
    assert.strictEqual(c.n, 10)
    close(c.trimmedMean, 13 / 6)
    close(c.winsorVar, 6.9 / 9, 1e-12)
    // A burst inside the window cannot inflate the scale: a flat background stays at exactly 0.
    const flat = cfarLocalStats([...Array(10).fill(4), 999, ...Array(10).fill(4)], { reference: 10, guard: 0, trim: 0.25, minReference: 1 })
    close(flat[10]!.winsorVar, 0)
    close(flat[10]!.trimmedMean, 4)
  })
  test('an include mask restricts the sample (the hurdle: ACTIVE cells only)', () => {
    const xs = Array(40).fill(3)
    const include = xs.map((_, j) => j % 2 === 0)
    const c = cfarLocalStats(xs, { reference: 10, guard: 0, minReference: 1, include })
    assert.strictEqual(c[20]!.n, 10) // 5 even cells per side
  })
})

suite('seismicStats — magnitude (Gutenberg–Richter analog)', () => {
  test('M = log₁₀(energy/reference); 0 when no excess', () => {
    close(magnitude(1000, 10), 2) // 100× the baseline ⇒ magnitude 2
    close(magnitude(10, 10), 0)
    close(magnitude(5, 10), 0)
  })
})
