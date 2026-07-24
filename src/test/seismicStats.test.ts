// seismicStats — every primitive asserted against a HAND-COMPUTED textbook value, so the burn
// analysis' math is provable, not asserted. Constants come from the cited sources, not from the code.
import * as assert from 'assert'
import {
  median, mad, meanAbsDev, robustBaseline, modifiedZ, modifiedZScores,
  lgamma, poissonSF, benjaminiHochberg, benjaminiYekutieli, staLta, cusum, magnitude,
  erf, normalCdf, normalSf, chiSquaredSF4, fisherCombine, robustNoiseSigma, pelt,
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

suite('seismicStats — magnitude (Gutenberg–Richter analog)', () => {
  test('M = log₁₀(energy/reference); 0 when no excess', () => {
    close(magnitude(1000, 10), 2) // 100× the baseline ⇒ magnitude 2
    close(magnitude(10, 10), 0)
    close(magnitude(5, 10), 0)
  })
})
