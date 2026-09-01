---
name: burn-seismic-statistical-model
description: "burn_seismic reports wrong/implausible p-values / which null model does the burn anomaly detection use / why was v1 mis-calibrated / calibration self-check says 13% when 5% expected / detector flags every busy minute / PELT shatters the series into singletons / spawn list shows calls from hours outside the event / how are burn root causes (fan-out vs thrash vs marathon) decided statistically"
ocd: 2026-07-24
lmd: 2026-09-01
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# burn_seismic — the statistical model of the burn anomaly detector (v2)

^0FYWPHG2 [desc:"burn_seismic (burnSeismic.ts + seismicStats.ts) measures a token burn as a reproducible statistical event via a rebuilt v2 model, not a heuristic verdict", keywords:"what_is_burn_seismic burn_anomaly_detector_overview burnSeismic_ts_seismicStats_ts statistical_event_not_heuristic_verdict v2_13_0_model_rebuild which_tool_measures_a_token_burn", ocd:2026-07-24, lmd:2026-07-24]
`burn_seismic` (src/burnSeismic.ts + src/seismicStats.ts, CLI tool since v2.12.0, model rebuilt in
v2.13.0 commits `5e373f1`+`1be8034`) measures a token burn as a reproducible statistical event, not
a heuristic verdict. The load-bearing design facts:

^19ZTGT83 [desc:"the burn null model is a marked point process (turn count x lognormal per-turn cost), never a Gaussian on raw dollars per minute", keywords:"which_null_model_does_burn_anomaly_detection_use marked_point_process_null gaussian_on_raw_cost_is_wrong why_was_v1_mis_calibrated zero_inflated_right_skewed_cost_series fdr_bound_void_on_wrong_null", ocd:2026-07-24, lmd:2026-07-24]
- **The null is the series' true generative structure — a MARKED POINT PROCESS:** cost/min =
  (count of turns) × (lognormal per-turn cost). Never test raw $/min against a Gaussian: it is
  non-negative, right-skewed, zero-inflated, and the p-values come out mis-calibrated (that was
  v1's core defect — ordering right, magnitudes wrong, FDR bound void).
^1D0YVJV7 [desc:"burn_seismic runs two factor tests (rate on counts, robust lognormal intensity) combined by Fisher's method with a closed-form chi-squared-4 tail", keywords:"two_factor_tests_rate_and_intensity fishers_method_combined_p_value chi_squared_4_closed_form robust_lognormal_intensity_test poisson_thinning_independence active_buckets_only_hurdle", ocd:2026-07-24, lmd:2026-07-24]
- **Two factor tests, each with its correct tail:** a RATE test on the counts + a robust lognormal
  INTENSITY test (log per-turn cost, median/MAD, ACTIVE buckets only — the hurdle that fixes
  zero-inflation). Combined by **Fisher's method**, χ²₄ closed form `e^(−x/2)(1+x/2)`; independent
  under H₀ by Poisson thinning.
^1JUYO8RA [desc:"v2.14 replaced the v2.13 stationary-Poisson background with a LOCAL CFAR background and an over-dispersed negative-binomial count law, because live data refuted both prior assumptions", keywords:"local_background_over_dispersed_count_law v2_14_calibration_fix cfar_reference_window_guard_band negative_binomial_rate_tail global_versus_local_null intensity_3_2_percent_rate_13_5_percent_miscalibration measured_sigma_squared_over_mu_1_9_to_7_2 global_plus_nb_detects_nothing local_plus_nb_keeps_the_mainshock", ocd:2026-07-25, lmd:2026-07-25]
- **The background is LOCAL, and the count law is OVER-DISPERSED (v2.14, `68ed110`+`7ed3848`).**
  Exact tails over wrong assumptions still mis-calibrate: v2.13 asserted a STATIONARY background
  (one global λ̂) and a POISSON law (variance = mean). Live data refuted both, and decomposing the
  p-values named the culprit precisely — intensity 3.2% of background under 0.05, RATE 13.5%.
  - **Level:** each bucket's background comes from a **CFAR** reference window minus a **guard
    band** (Finn–Johnson 1968; trimmed-mean variant Gandhi–Kassam 1988), so a day/night regime is
    not an anomaly and an event can never set its own baseline. Excess = observed − the summed
    LOCAL expectation of the event's own buckets.
  - **Shape:** turns arrive in CLUSTERS, so σ² ≫ μ (measured median σ²/μ ≈ 1.9 local, 7.2 global);
    the rate tail is the **negative binomial** (Poisson–Gamma, method-of-moments off the local
    *winsorized* variance) wherever over-dispersed. It CONTAINS Poisson, so it can only remove
    false alarms. `rateLaw:'poisson'` and `cfarReference:0` force each old assumption back as a
    falsifier.
  - **They are complementary and neither suffices:** global+NB scores a "good" 5.4% by detecting
    NOTHING (the regime mixture inflates dispersion until the null swallows every event);
    local+NB keeps the mainshock and collapses dispersion to 1.9.
^2KEFFCYP [desc:"burn root cause is decided by which factor's p-value is significant: rate alone means FANOUT_RATE, intensity alone means thrash or marathon, both means COMPOUND, with a 2x dominance rule", keywords:"how_are_burn_root_causes_decided_statistically fanout_rate_vs_fat_turn_thrash_vs_marathon compound_root_cause dominance_rule_2x_min_p decomposition_is_the_root_cause spawn_storm_versus_cold_write_versus_excess_read", ocd:2026-07-24, lmd:2026-07-24]
- **The decomposition IS the root cause:** rate evidence ⇒ `FANOUT_RATE` (spawn storm); intensity
  evidence ⇒ `FAT_TURN_THRASH` (excess cold-write) or `FAT_TURN_MARATHON` (excess read); both ⇒
  `COMPOUND`. Dominance rule: −ln(min p) of one factor ≥ 2× the other.
^4GVQ7OVZ [desc:"significance uses BH-FDR (by-method for arbitrary dependence) and the calibration self-check reports Storey's pi-hat-0 plus upper-half histogram uniformity to separate real signal from mis-specification", keywords:"calibration_self_check_says_13_percent_when_5_percent_expected storeys_pi_hat_0_null_attributable_share upper_half_histogram_uniformity_test bh_fdr_default_by_method benjamini_yekutieli_prds_valid confounded_by_real_signal_metric", ocd:2026-07-25, lmd:2026-07-25]
- **Significance:** BH-FDR default (PRDS-valid per Benjamini–Yekutieli 2001), `fdrMethod: 'by'`
  for arbitrary dependence. The **calibration self-check reports what it can actually measure**:
  the raw "background share with p<0.05" is CONFOUNDED by real signal (a better detector finds
  more true anomalies below the FDR bar, so the number RISES as the null improves), so the report
  adds **Storey's π̂₀** (2002) for the null-attributable part α·π̂₀ and the **upper-half histogram
  uniformity** — signal cannot bend the p>0.5 half, so its flatness is the real specification
  test. Live: `background p<0.05 = 11.5%, of which 4.6% null-attributable (π̂₀=0.92), uniformity 2.6×`.
^4VGXKPQO [desc:"detector flags every busy minute because it should — events are PELT changepoint segments on log1p cost, ranked by excess over baseline never raw totals", keywords:"detector_flags_every_busy_minute pelt_shatters_the_series_into_singletons pelt_changepoint_segments_killick_2012 elevated_plateau_versus_lone_spike ranking_by_excess_over_baseline_not_raw_totals", ocd:2026-07-24, lmd:2026-07-24]
- **Events = PELT segments** (Killick 2012, exact penalized changepoints on log1p cost) containing
  FDR-significant buckets; elevated segments taken whole (plateau), non-elevated shrunk to the
  significant core (lone spike). Ranking by **EXCESS over baseline**, never raw totals.
^529O0R5F [desc:"attribution reports per-session excess vs the session's own out-of-event rate, tagged COLD_REWRITE or MODEL_SWITCH, with the mainshock spawn calls verbatim", keywords:"spawn_list_shows_calls_from_hours_outside_the_event per_session_excess_attribution cold_rewrite_tag_80_percent_of_max_prefix model_switch_tag mainshock_spawn_calls_verbatim", ocd:2026-07-24, lmd:2026-07-24]
- **Attribution:** per event, per-session excess vs that session's own out-of-event rate, with
  `COLD_REWRITE` (single-turn cache_creation ≥ 80% of the session's max prefix, ≥50k floor) and
  `MODEL_SWITCH` tags; spawn calls inside the mainshock verbatim.
^5EIKA7DX [desc:"every seismicStats.ts primitive is unit-tested against a textbook constant and cross-checked against the stochastic DuckDB extension, since no general DuckDB stats extension ships STA/LTA, CUSUM, or BH-FDR", keywords:"provability_contract_unit_tested_primitives stochastic_duckdb_extension_cross_check textbook_hand_computed_constant no_duckdb_extension_ships_sta_lta_cusum_bh_fdr which_engine_computed_this_result", ocd:2026-07-24, lmd:2026-07-24]
- **Provability contract:** every primitive in src/seismicStats.ts is unit-tested against a
  hand-computed textbook constant, and the distribution tails are cross-checked against the
  `stochastic` DuckDB community extension (Δ≤2e-16 Poisson, ≤7e-8 normal); the engine used is
  disclosed in every result. No general DuckDB stats extension ships STA/LTA, CUSUM, or BH-FDR —
  those stay in the tested TS core.

^5U4JIS9D [desc:"any new burn/cost anomaly feature must test against the burn_seismic null model or extend it, rank by excess, and disclose calibration, never mean-plus-k-sigma on a raw cost series", keywords:"how_are_burn_root_causes_decided_statistically which_null_model_does_the_burn_anomaly_detection_use never_mean_plus_k_sigma_on_raw_cost two_investigations_reached_different_verdicts spawn_count_view_versus_cost_view", ocd:2026-07-25, lmd:2026-07-25]
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

[^5]: [id:ATOM-EXACT-TAIL-WRONG-NULL, status:valid, keywords:"exact_tail_wrong_assumption stationary_background poisson_variance_equals_mean overdispersed_counts calibration_miss_persists", ocd:2026-07-25, lmd:2026-07-25]
  DO NOT treat "each factor now has its exact tail" as a calibrated null, BECAUSE exactness is
  computed WITHIN assumptions and v2.13's two assumptions were both false — a stationary background
  (one global λ̂ over a day/night series) and variance = mean (arrivals actually CLUSTER, measured
  σ²/μ ≈ 1.9–7.2) — so the 13.5% false-alarm share survived every tail correction. DO measure the
  assumptions themselves (dispersion index, per-regime level) before trusting a p-value's magnitude.

[^6]: [id:ATOM-CAL-CONFOUND, status:valid, keywords:"calibration_metric_confounded_by_signal better_detector_looks_worse chasing_5_percent blindness_scores_best", ocd:2026-07-25, lmd:2026-07-25]
  DO NOT tune a detector toward "background share with p<0.05 ≤ 5%", BECAUSE that share counts real
  anomalies that missed the FDR bar, so it RISES as the null improves (the better local null read
  13.3% against the worse global null's 9.8%) — and the configuration that scored best (5.4%)
  detected NOTHING AT ALL. DO separate signal from mis-specification with Storey's π̂₀ (the
  null-attributable part is α·π̂₀) and the uniformity of the p>0.5 half, which signal cannot bend.

[^7]: [id:ATOM-LOCAL-DEGEN, status:valid, keywords:"local_window_degeneracy zero_rate_infinite_significance flat_window_no_scale jeffreys_floor pooled_scale", ocd:2026-07-25, lmd:2026-07-25]
  DO NOT drop a global estimator for a local one without handling the degeneracies a small window
  creates, BECAUSE a finite window of zeros yields λ̂=0 (making ANY single turn infinitely
  significant — P(X≥1|0)=0) and a perfectly flat window yields zero scale (making a robust z either
  0, i.e. a fat turn beside 25 quiet ones scores NOTHING — the failure that broke 4 fixtures — or
  ±∞). DO floor the rate at the Jeffreys ½-event rate and take the local LOCATION with the
  window-wide SCALE when the local scale collapses.

[^4]: [id:ATOM-ROBZ-SATN, status:valid, keywords:"meanad_fallback_saturation contamination_bound robust_z_cap plateau_not_detected", ocd:2026-07-24, lmd:2026-07-24]
  DO NOT expect a robust modified-z to flag a shift carried by a large mass fraction f of the data,
  BECAUSE under the meanAD fallback the score saturates at ≈ 1/(1.253314·f) (25% contamination caps
  z at ~3.2 — below the 3.5 flag) — that is robustness working, not a bug. DO detect sustained
  regime shifts with a changepoint method (PELT) and keep outlier tests for the minority-mass
  spikes.
