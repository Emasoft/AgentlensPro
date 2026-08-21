// Regenerates seismicstats-expected.json from the COMPILED src/seismicStats.ts — the parity oracle
// for the statistical primitives (TRDD-DMWOBWFH P4x.2r).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicstats-expected.mjs
//
// NON-FINITE ENCODING: `JSON.stringify(NaN)` is `null`, and `median([])` is legitimately NaN — so a
// plain dump would erase the difference between "not a number" and "no value". Every non-finite is
// encoded as its STRING name and decoded the same way on the Rust side.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const S = await import(path.join(HERE, '../../../../../out/test/seismicStats.js'))

const enc = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : (Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Infinity' : '-Infinity'))
  if (Array.isArray(v)) return v.map(enc)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]))
  return v
}

// The series are chosen for the regimes each primitive has a SEPARATE branch for, not for variety:
//  - `ties` collapses MAD to exactly 0 (the mean-abs-dev fallback),
//  - `residue` collapses it to float RESIDUE instead (the RELATIVE gate — a `mad > 0` test passes
//    here and then divides by ~1e-16, turning every point into a fake extreme outlier),
//  - `zeroInflated` is what a real cost series looks like (most minutes quiet),
//  - `step` has a genuine level shift, which is what PELT must find and MAD must NOT mistake for
//    noise.
const series = {
  empty: [],
  one: [7],
  two: [3, 5],
  odd: [5, 1, 9, 3, 7],
  ties: [4, 4, 4, 4, 4, 4, 4, 9],
  residue: [4.8, 5.2, 4.8, 5.2, 4.8, 5.2, 4.8, 30],
  zeroInflated: [0, 0, 0, 0, 0.01, 0, 0, 0.02, 0, 0, 3.5, 0, 0, 0],
  step: [1, 1.1, 0.9, 1.05, 0.95, 8, 8.2, 7.9, 8.1, 8.05, 1, 1.1, 0.9],
  negatives: [-5, -1, 0, 1, 5],
  burst: Array.from({ length: 40 }, (_, i) => (i === 25 ? 50 : (i % 7) * 0.3)),
}

const out = { series, median: {}, mad: {}, meanAbsDev: {}, robustBaseline: {}, modifiedZScores: {}, robustNoiseSigma: {}, pelt: {}, staLta: {}, cusum: {} }
for (const [k, xs] of Object.entries(series)) {
  out.median[k] = enc(S.median(xs))
  out.mad[k] = enc(S.mad(xs))
  out.meanAbsDev[k] = enc(S.meanAbsDev(xs))
  out.robustBaseline[k] = enc(S.robustBaseline(xs))
  out.modifiedZScores[k] = enc(S.modifiedZScores(xs))
  out.robustNoiseSigma[k] = enc(S.robustNoiseSigma(xs))
  out.pelt[k] = enc(S.pelt(xs))
  out.staLta[k] = enc(S.staLta(xs, 3, 10, 4, 1.5))
  out.cusum[k] = enc(S.cusum(xs, 1, 0.5, 5))
}

// modifiedZ point-wise, including both collapse branches and the "no scale at all" case.
out.modifiedZ = [
  [10, 5, 2, 3], [10, 5, 0, 3], [10, 5, 1e-17, 1], [10, 5, 0, 0], [5, 5, 0, 0], [-10, 5, 2, 3],
].map(([x, med, madv, meanAD]) => ({ args: [x, med, madv, meanAD], out: enc(S.modifiedZ(x, med, madv, meanAD)) }))

// lgamma across the reflection boundary (z<0.5 uses Γ(z)Γ(1−z)=π/sin(πz)) and into the range the
// Poisson/NB sums actually use.
out.lgamma = [0.1, 0.4999, 0.5, 1, 1.5, 2, 5, 10, 50, 170, 0.5 - 1e-9].map((z) => ({ z, out: enc(S.lgamma(z)) }))

out.poissonSF = [[0, 5], [-1, 5], [1, 0], [1, 5], [3, 5], [10, 5], [25, 5], [1, 0.001], [50, 40]]
  .map(([k, l]) => ({ args: [k, l], out: enc(S.poissonSF(k, l)) }))

// The NB's THREE branches: over-dispersed (its own law), NOT over-dispersed (falls back to the exact
// Poisson tail — under-dispersion is not evidence for a wider law), and the degenerate mean.
out.negBinomSF = [[0, 5, 20], [5, 5, 20], [10, 5, 20], [25, 5, 20], [10, 5, 5], [10, 5, 3], [10, 0, 5], [10, -1, 5], [3, 2, 100]]
  .map(([k, m, v]) => ({ args: [k, m, v], out: enc(S.negBinomSF(k, m, v)) }))

out.erf = [-3, -1, -0.5, 0, 0.5, 1, 2, 3, 6].map((x) => ({ x, erf: enc(S.erf(x)), cdf: enc(S.normalCdf(x)), sf: enc(S.normalSf(x)) }))

out.chiSquaredSF4 = [-1, 0, 0.5, 1, 4, 9.488, 50, Infinity].map((x) => ({ x: enc(x), out: enc(S.chiSquaredSF4(x)) }))
out.fisherCombine = [[0.5, 0.5], [0.01, 0.01], [1, 1], [0, 0.5], [0.5, 0], [-1, 0.5], [2, 0.5], [1e-12, 1e-12]]
  .map(([a, b]) => ({ args: [a, b], out: enc(S.fisherCombine(a, b)) }))

// p-value sets: one with real signal, one pure-null, one with TIES at the cut (the rejected SET
// depends on the sort being stable), and the empty case.
const pset = {
  empty: [],
  signal: [0.0001, 0.001, 0.008, 0.02, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95],
  null_only: Array.from({ length: 20 }, (_, i) => (i + 0.5) / 20),
  ties: [0.01, 0.01, 0.01, 0.01, 0.5, 0.5, 0.9, 0.9],
  all_one: [1, 1, 1],
}
out.pset = pset
out.bh = {}
out.by = {}
out.storeyPi0 = {}
out.upperTailUniformity = {}
for (const [k, ps] of Object.entries(pset)) {
  out.bh[k] = enc(S.benjaminiHochberg(ps, 0.05))
  out.by[k] = enc(S.benjaminiYekutieli(ps, 0.05))
  out.storeyPi0[k] = enc(S.storeyPi0(ps))
  out.upperTailUniformity[k] = enc(S.upperTailUniformity(ps))
}

// CFAR: the disabled case (R=0 ⇒ every cell null), the too-few-references case (every cell null so
// the CALLER falls back to a global estimate — a 3-sample background would be worse than none), a
// working window, and a masked one.
const cfarXs = series.burst
out.cfar = {
  disabled: enc(S.cfarLocalStats(cfarXs, { reference: 0, guard: 2 })),
  too_few: enc(S.cfarLocalStats(cfarXs, { reference: 5, guard: 2, minReference: 30 })),
  working: enc(S.cfarLocalStats(cfarXs, { reference: 12, guard: 2, minReference: 8, trim: 0.25 })),
  no_trim: enc(S.cfarLocalStats(cfarXs, { reference: 12, guard: 2, minReference: 8, trim: 0 })),
  masked: enc(S.cfarLocalStats(cfarXs, { reference: 12, guard: 2, minReference: 8, include: cfarXs.map((v) => v > 0) })),
}

out.magnitude = [[10, 1], [1, 10], [0, 1], [10, 0], [10, -1], [100, 1]].map(([e, r]) => ({ args: [e, r], out: enc(S.magnitude(e, r)) }))

fs.writeFileSync(path.join(HERE, 'seismicstats-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote seismicstats-expected.json')
console.log(' series:', Object.keys(series).join(' '))
console.log(' pelt changepoints:', Object.entries(out.pelt).map(([k, v]) => `${k}=${v.changepoints.length}`).join(' '))
console.log(' bh rejected:', Object.entries(out.bh).map(([k, v]) => `${k}=${v.nRejected}`).join(' '))
