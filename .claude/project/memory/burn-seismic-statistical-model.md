---
name: burn-seismic-statistical-model
description: "burn_seismic reports wrong/implausible p-values / which null model does the burn anomaly detection use / why was v1 mis-calibrated / PELT shatters the series into singletons / spawn list shows calls from hours outside the event / how are burn root causes (fan-out vs thrash vs marathon) decided statistically"
ocd: 2026-07-24
lmd: 2026-07-24
metadata:
  node_type: memory
  type: project
  tier: component
---

# burn_seismic — the statistical model of the burn anomaly detector (v2)

`burn_seismic` (src/burnSeismic.ts + src/seismicStats.ts, CLI tool since v2.12.0, model rebuilt in
v2.13.0 commits `5e373f1`+`1be8034`) measures a token burn as a reproducible statistical event, not
a heuristic verdict. The load-bearing design facts:

- **The null is the series' true generative structure — a MARKED POINT PROCESS:** cost/min =
  (Poisson turn count) × (lognormal per-turn cost). Never test raw $/min against a Gaussian: it is
  non-negative, right-skewed, zero-inflated, and the p-values come out mis-calibrated (that was
  v1's core defect — ordering right, magnitudes wrong, FDR bound void).
- **Two factor tests, each with its correct tail:** exact Poisson RATE test (λ̂ = trimmed
  background mean) + robust lognormal INTENSITY test (log per-turn cost, median/MAD, ACTIVE
  buckets only — the hurdle that fixes zero-inflation). Combined by **Fisher's method**, χ²₄
  closed form `e^(−x/2)(1+x/2)`; independent under H₀ by Poisson thinning.
- **The decomposition IS the root cause:** rate evidence ⇒ `FANOUT_RATE` (spawn storm); intensity
  evidence ⇒ `FAT_TURN_THRASH` (excess cold-write) or `FAT_TURN_MARATHON` (excess read); both ⇒
  `COMPOUND`. Dominance rule: −ln(min p) of one factor ≥ 2× the other.
- **Significance:** BH-FDR default (PRDS-valid per Benjamini–Yekutieli 2001), `fdrMethod: 'by'`
  for arbitrary dependence. Every report prints a **calibration self-check** (background share
  with p<0.05; expected ≤5%, Poisson-discrete conservative — the live fleet shows ~13% from
  day/night regime nonstationarity under one global λ̂; a rolling baseline is the known refinement).
- **Events = PELT segments** (Killick 2012, exact penalized changepoints on log1p cost) containing
  FDR-significant buckets; elevated segments taken whole (plateau), non-elevated shrunk to the
  significant core (lone spike). Ranking by **EXCESS over baseline**, never raw totals.
- **Attribution:** per event, per-session excess vs that session's own out-of-event rate, with
  `COLD_REWRITE` (single-turn cache_creation ≥ 80% of the session's max prefix, ≥50k floor) and
  `MODEL_SWITCH` tags; spawn calls inside the mainshock verbatim.
- **Provability contract:** every primitive in src/seismicStats.ts is unit-tested against a
  hand-computed textbook constant, and the distribution tails are cross-checked against the
  `stochastic` DuckDB community extension (Δ≤2e-16 Poisson, ≤7e-8 normal); the engine used is
  disclosed in every result. No general DuckDB stats extension ships STA/LTA, CUSUM, or BH-FDR —
  those stay in the tested TS core.

**Why:** two credible investigations of the same 2026-07-23 burn reached different verdicts
(spawn-count vs cost view); only a calibrated measurement settles such disputes.
**How to apply:** any new burn/cost anomaly feature must test against this null (or extend it),
rank by excess, and disclose calibration — never mean±kσ on a raw cost series.

See also: [[agentlens-burn-token-model]] (the cost/cache economics the $ series is built from),
[[cache-ttl-model]] (why cold writes spike), [[agent-fleet-cache-economics]] (measured fleet
spawn/boot economics — what a FANOUT_RATE event's culprits did wrong).

## Notes and lessons learned

[^1]: [id:ATOM-MADG-FP16, status:valid, keywords:"mad_zero_collapse float_residue pelt_oversegmentation identical_diffs exact_zero_guard", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT gate a MAD-collapse fallback with `mad > 0`, BECAUSE a majority of identical values leaves
  MAD ≈ 1e-16 float residue (e.g. 4.8−5.2 = −0.40000000000000036), and dividing by a residue scale
  makes every wiggle an infinite outlier (PELT shattered a series into singletons; zero-inflated
  cost series hit this ROUTINELY via zero diffs). DO use a relative gate (`mad > 1e-8·meanAD`) with
  the Iglewicz–Hoaglin meanAD fallback instead.

[^2]: [id:ATOM-TSCM-LEAK, status:valid, keywords:"timestamp_compare_leak duckdb_varchar_timestamp spawn_window_leak iso_t_vs_space", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT compare a raw ISO-T VARCHAR timestamp ('…T11:27:00Z') against a naive-format bound
  ('… 11:27:00') in SQL, BECAUSE the lexical compare breaks at char 11 ('T' > ' ') and silently
  passes EVERY line of the day — the live fleet run listed 01:14 spawns inside an 11:27 mainshock.
  DO CAST both sides to TIMESTAMP (`CAST(ts AS TIMESTAMP) >= TIMESTAMP '<bound>'`) and pin the
  window with a fixture asserting an out-of-window row is excluded.

[^3]: [id:ATOM-GAUS-NULL, status:valid, keywords:"gaussian_null_miscalibrated skewed_cost_pvalues fdr_bound_void normal_on_raw_cost", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT compute p-values as normalSf(modified-z) on a raw cost/count series, BECAUSE the series is
  skewed/zero-inflated so the p magnitudes are wrong and any FDR bound built on them is void (v1's
  defect). DO factor the series into its generative parts (Poisson rate × lognormal intensity) and
  give each its correct tail, combining with Fisher.

[^4]: [id:ATOM-ROBZ-SATN, status:valid, keywords:"meanad_fallback_saturation contamination_bound robust_z_cap plateau_not_detected", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT expect a robust modified-z to flag a shift carried by a large mass fraction f of the data,
  BECAUSE under the meanAD fallback the score saturates at ≈ 1/(1.253314·f) (25% contamination caps
  z at ~3.2 — below the 3.5 flag) — that is robustness working, not a bug. DO detect sustained
  regime shifts with a changepoint method (PELT) and keep outlier tests for the minority-mass
  spikes.
