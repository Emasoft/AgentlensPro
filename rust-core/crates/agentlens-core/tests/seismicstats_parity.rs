//! Cross-engine parity for `src/seismicStats.ts` (TRDD-DMWOBWFH P4x.2r). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicstats-expected.mjs
//!
//! NUMERIC TOLERANCE, and why it is not a cop-out: `exp`, `log`, `sin` and `log10` are libm
//! functions, and V8 ships its OWN fdlibm port while Rust calls the platform's — so the two can and
//! do differ in the last ulp on a transcendental. Everything DISCRETE (which buckets were rejected,
//! which indices alarmed, how many changepoints) is compared EXACTLY, because those are decisions,
//! not measurements; only the continuous values carry a relative epsilon of 1e-12, which is ~4
//! orders of magnitude tighter than any of these statistics is meaningful to.

use agentlens_core::seismic_stats as st;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicstats-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The generator encodes every non-finite as its STRING name, because `JSON.stringify(NaN)` is
/// `null` and `median([])` is legitimately NaN — a plain dump would erase the difference between
/// "not a number" and "no value".
fn dec(v: &Value) -> f64 {
    match v {
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        _ => v.as_f64().unwrap_or_else(|| panic!("not a number: {v}")),
    }
}

#[track_caller]
fn close(got: f64, exp: &Value, label: &str) {
    let e = dec(exp);
    if e.is_nan() {
        assert!(got.is_nan(), "{label}: expected NaN, got {got}");
        return;
    }
    if e.is_infinite() {
        assert_eq!(got, e, "{label}");
        return;
    }
    let tol = 1e-12 * e.abs().max(1.0);
    assert!((got - e).abs() <= tol, "{label}: got {got}, exp {e} (Δ {})", (got - e).abs());
}

#[track_caller]
fn close_all(got: &[f64], exp: &Value, label: &str) {
    let ea = exp.as_array().unwrap_or_else(|| panic!("{label}: not an array: {exp}"));
    assert_eq!(got.len(), ea.len(), "{label}: length");
    for (i, (g, e)) in got.iter().zip(ea).enumerate() {
        close(*g, e, &format!("{label}[{i}]"));
    }
}

fn series(o: &Value, name: &str) -> Vec<f64> {
    o["series"][name].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn names(o: &Value) -> Vec<String> {
    o["series"].as_object().unwrap().keys().cloned().collect()
}

#[test]
fn location_scale_and_baseline_match() {
    let o = oracle();
    for k in names(&o) {
        let xs = series(&o, &k);
        close(st::median(&xs), &o["median"][&k], &format!("median({k})"));
        let med = st::median(&xs);
        close(st::mad(&xs, med), &o["mad"][&k], &format!("mad({k})"));
        close(st::mean_abs_dev(&xs, med), &o["meanAbsDev"][&k], &format!("meanAbsDev({k})"));
        let b = st::robust_baseline(&xs);
        let e = &o["robustBaseline"][&k];
        close(b.median, &e["median"], &format!("baseline({k}).median"));
        close(b.mad, &e["mad"], &format!("baseline({k}).mad"));
        close(b.mean_ad, &e["meanAD"], &format!("baseline({k}).meanAD"));
        close(b.sigma_hat, &e["sigmaHat"], &format!("baseline({k}).sigmaHat"));
        close_all(&st::modified_z_scores(&xs, None), &o["modifiedZScores"][&k], &format!("modZ({k})"));
        close(st::robust_noise_sigma(&xs), &o["robustNoiseSigma"][&k], &format!("noiseSigma({k})"));
    }
    for case in o["modifiedZ"].as_array().unwrap() {
        let a: Vec<f64> = case["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        close(st::modified_z(a[0], a[1], a[2], a[3]), &case["out"], &format!("modifiedZ{:?}", a));
    }
}

#[test]
fn tails_and_combination_match() {
    let o = oracle();
    for case in o["lgamma"].as_array().unwrap() {
        let z = case["z"].as_f64().unwrap();
        close(st::lgamma(z), &case["out"], &format!("lgamma({z})"));
    }
    for case in o["poissonSF"].as_array().unwrap() {
        let a: Vec<f64> = case["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        close(st::poisson_sf(a[0], a[1]), &case["out"], &format!("poissonSF{:?}", a));
    }
    for case in o["negBinomSF"].as_array().unwrap() {
        let a: Vec<f64> = case["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        close(st::neg_binom_sf(a[0], a[1], a[2]), &case["out"], &format!("negBinomSF{:?}", a));
    }
    for case in o["erf"].as_array().unwrap() {
        let x = case["x"].as_f64().unwrap();
        close(st::erf(x), &case["erf"], &format!("erf({x})"));
        close(st::normal_cdf(x), &case["cdf"], &format!("normalCdf({x})"));
        close(st::normal_sf(x), &case["sf"], &format!("normalSf({x})"));
    }
    for case in o["chiSquaredSF4"].as_array().unwrap() {
        let x = dec(&case["x"]);
        close(st::chi_squared_sf4(x), &case["out"], &format!("chiSquaredSF4({x})"));
    }
    for case in o["fisherCombine"].as_array().unwrap() {
        let a: Vec<f64> = case["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        close(st::fisher_combine(a[0], a[1]), &case["out"], &format!("fisherCombine{:?}", a));
    }
    for case in o["magnitude"].as_array().unwrap() {
        let a: Vec<f64> = case["args"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        close(st::magnitude(a[0], a[1]), &case["out"], &format!("magnitude{:?}", a));
    }
}

#[test]
fn fdr_and_calibration_match() {
    let o = oracle();
    for (k, ps) in o["pset"].as_object().unwrap() {
        let ps: Vec<f64> = ps.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        for (verb, got) in [("bh", st::benjamini_hochberg(&ps, 0.05)), ("by", st::benjamini_yekutieli(&ps, 0.05))] {
            let e = &o[verb][k];
            // The rejected SET is a DECISION — compared exactly, no tolerance. A tie at the cut is
            // decided by the sort's stability, which is a property both engines must share.
            let exp_rej: Vec<bool> = e["rejected"].as_array().unwrap().iter().map(|v| v.as_bool().unwrap()).collect();
            assert_eq!(got.rejected, exp_rej, "{verb}({k}).rejected");
            assert_eq!(got.n_rejected, e["nRejected"].as_u64().unwrap() as usize, "{verb}({k}).nRejected");
            close(got.threshold, &e["threshold"], &format!("{verb}({k}).threshold"));
        }
        close(st::storey_pi0(&ps, 0.5), &o["storeyPi0"][k], &format!("storeyPi0({k})"));
        close(st::upper_tail_uniformity(&ps, 10), &o["upperTailUniformity"][k], &format!("upperUniformity({k})"));
    }
}

#[test]
fn detectors_and_segmentation_match() {
    let o = oracle();
    for k in names(&o) {
        let xs = series(&o, &k);

        let sl = st::sta_lta(&xs, 3, 10, 4.0, 1.5);
        let e = &o["staLta"][&k];
        close_all(&sl.ratio, &e["ratio"], &format!("staLta({k}).ratio"));
        let et = e["triggers"].as_array().unwrap();
        assert_eq!(sl.triggers.len(), et.len(), "staLta({k}).triggers count");
        for (i, (g, x)) in sl.triggers.iter().zip(et).enumerate() {
            // Indices are decisions: exact.
            assert_eq!(g.from as u64, x["from"].as_u64().unwrap(), "staLta({k}).trigger[{i}].from");
            assert_eq!(g.to as u64, x["to"].as_u64().unwrap(), "staLta({k}).trigger[{i}].to");
            assert_eq!(g.peak_index as u64, x["peakIndex"].as_u64().unwrap(), "staLta({k}).trigger[{i}].peakIndex");
            close(g.peak_ratio, &x["peakRatio"], &format!("staLta({k}).trigger[{i}].peakRatio"));
        }

        let cu = st::cusum(&xs, 1.0, 0.5, 5.0);
        let e = &o["cusum"][&k];
        close_all(&cu.splus, &e["splus"], &format!("cusum({k}).splus"));
        close_all(&cu.sminus, &e["sminus"], &format!("cusum({k}).sminus"));
        let ea: Vec<usize> = e["alarms"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(cu.alarms, ea, "cusum({k}).alarms");

        let p = st::pelt(&xs, None);
        let e = &o["pelt"][&k];
        let ecp: Vec<usize> = e["changepoints"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(p.changepoints, ecp, "pelt({k}).changepoints");
        let eseg = e["segments"].as_array().unwrap();
        assert_eq!(p.segments.len(), eseg.len(), "pelt({k}).segments count");
        for (i, (g, x)) in p.segments.iter().zip(eseg).enumerate() {
            assert_eq!(g.from as u64, x["from"].as_u64().unwrap(), "pelt({k}).seg[{i}].from");
            assert_eq!(g.to as u64, x["to"].as_u64().unwrap(), "pelt({k}).seg[{i}].to");
            close(g.mean, &x["mean"], &format!("pelt({k}).seg[{i}].mean"));
        }
    }
}

#[test]
fn cfar_matches() {
    let o = oracle();
    let xs = series(&o, "burst");
    let mask: Vec<bool> = xs.iter().map(|v| *v > 0.0).collect();
    let cases: Vec<(&str, st::CfarOptions<'_>)> = vec![
        ("disabled", st::CfarOptions { reference: 0.0, guard: 2.0, trim: None, min_reference: None, include: None }),
        ("too_few", st::CfarOptions { reference: 5.0, guard: 2.0, trim: None, min_reference: Some(30.0), include: None }),
        ("working", st::CfarOptions { reference: 12.0, guard: 2.0, trim: Some(0.25), min_reference: Some(8.0), include: None }),
        ("no_trim", st::CfarOptions { reference: 12.0, guard: 2.0, trim: Some(0.0), min_reference: Some(8.0), include: None }),
        ("masked", st::CfarOptions { reference: 12.0, guard: 2.0, trim: None, min_reference: Some(8.0), include: Some(&mask) }),
    ];
    for (name, opts) in cases {
        let got = st::cfar_local_stats(&xs, &opts);
        let exp = o["cfar"][name].as_array().unwrap();
        assert_eq!(got.len(), exp.len(), "cfar({name}) length");
        for (i, (g, e)) in got.iter().zip(exp).enumerate() {
            match (g, e.is_null()) {
                // A null cell is a DECISION — "too few references, fall back to the global
                // estimate" — so it is compared exactly, never coerced into a zeroed cell.
                (None, true) => {}
                (Some(c), false) => {
                    assert_eq!(c.n as u64, e["n"].as_u64().unwrap(), "cfar({name})[{i}].n");
                    close(c.trimmed_mean, &e["trimmedMean"], &format!("cfar({name})[{i}].trimmedMean"));
                    close(c.winsor_var, &e["winsorVar"], &format!("cfar({name})[{i}].winsorVar"));
                    close(c.baseline.median, &e["baseline"]["median"], &format!("cfar({name})[{i}].med"));
                    close(c.baseline.mad, &e["baseline"]["mad"], &format!("cfar({name})[{i}].mad"));
                    close(c.baseline.mean_ad, &e["baseline"]["meanAD"], &format!("cfar({name})[{i}].meanAD"));
                    close(c.baseline.sigma_hat, &e["baseline"]["sigmaHat"], &format!("cfar({name})[{i}].sigmaHat"));
                }
                _ => panic!("cfar({name})[{i}]: null-ness differs — got {:?}, exp {e}", g.is_some()),
            }
        }
    }
}
