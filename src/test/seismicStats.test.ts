// seismicStats — every primitive asserted against a HAND-COMPUTED textbook value, so the burn
// analysis' math is provable, not asserted. Constants come from the cited sources, not from the code.
import * as assert from 'assert'
import {
  median, mad, meanAbsDev, robustBaseline, modifiedZ, modifiedZScores,
  lgamma, poissonSF, benjaminiHochberg, staLta, cusum, magnitude,
  erf, normalCdf, normalSf,
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

suite('seismicStats — magnitude (Gutenberg–Richter analog)', () => {
  test('M = log₁₀(energy/reference); 0 when no excess', () => {
    close(magnitude(1000, 10), 2) // 100× the baseline ⇒ magnitude 2
    close(magnitude(10, 10), 0)
    close(magnitude(5, 10), 0)
  })
})
