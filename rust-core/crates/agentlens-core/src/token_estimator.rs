//! The ONE token-count source of truth (TRDD-IQENK7JM) — port of src/tokenEstimator.ts.
//!
//! Deliberately NO BPE dependency: js-tiktoken measures OpenAI's merges, not Claude's, so
//! bundling it would buy false precision (plus a supply-chain surface) while still being wrong
//! for Claude. Instead: a deterministic tiktoken-ISH segmenter landing within ~±10-15% on
//! English/code, and — wherever an EXACT total is known from a usage bucket — `calibrate_tokens`
//! scales the per-block estimates to that truth, which makes the calibrated numbers consistent
//! with Claude's real tokenization regardless of the estimator's own drift.
//!
//! UTF-16 LAW: the TS walks `charCodeAt`, i.e. UTF-16 CODE UNITS. An astral char (emoji,
//! CJK-ext-B) is TWO units there and both halves classify as `Other`. Iterating Rust `chars()`
//! would see one scalar and diverge; iterating bytes would diverge further. `encode_utf16()` is
//! the only faithful walk — the same trap already paid for in the logscan retention port.

/// Tuning constants, each justified in the TS header: prose ~4.7 chars/token WITHIN a word
/// (whitespace is counted separately), numbers ~3 digits/token, symbol runs merge (`=>`, `);`)
/// at ~2, indentation ~1 token per 4 spaces, CJK ~1 token per glyph, every newline ~1 token.
const LETTERS_PER_TOKEN: f64 = 4.7;
const DIGITS_PER_TOKEN: f64 = 3.0;
const SYMBOLS_PER_TOKEN: f64 = 2.0;
const SPACES_PER_TOKEN: f64 = 4.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cat {
    Other,
    Letter,
    Digit,
    Space,
    Cjk,
}

/// Classify one UTF-16 code unit. Newlines are handled by the caller (each ≈ 1 token) so they
/// are not a category. Letters cover ASCII + common Latin/Greek/Cyrillic; exotic letters fall
/// into Other (rare, small aggregate error). Surrogate halves read as Other — deliberately, and
/// that is only reproducible by walking code units.
fn categorize(c: u16) -> Cat {
    match c {
        48..=57 => Cat::Digit,
        32 | 9 => Cat::Space, // space, tab (newlines handled separately)
        65..=90 | 97..=122 => Cat::Letter,
        0xc0..=0x2af => Cat::Letter,  // Latin-1 supplement + Latin extended A/B
        0x370..=0x4ff => Cat::Letter, // Greek + Cyrillic
        0x3040..=0x30ff        // hiragana + katakana
        | 0x3400..=0x9fff      // CJK unified (incl. ext-A)
        | 0xac00..=0xd7a3      // hangul syllables
        | 0xf900..=0xfaff      // CJK compatibility ideographs
        | 0xff00..=0xffef      // fullwidth forms
        => Cat::Cjk,
        _ => Cat::Other,
    }
}

/// Tokens contributed by one homogeneous run. `js_math_round` for the Letter case because JS
/// `Math.round` is floor(x+0.5) — it breaks .5 ties AWAY from zero, where Rust's `f64::round`
/// agrees but `{:.0}` formatting would not; using the shared helper keeps one rounding rule.
fn run_tokens(cat: Cat, len: f64) -> f64 {
    match cat {
        Cat::Letter => crate::summarize::helpers::js_math_round(len / LETTERS_PER_TOKEN).max(1.0),
        Cat::Digit => (len / DIGITS_PER_TOKEN).ceil().max(1.0),
        Cat::Cjk => len,
        Cat::Space => (len / SPACES_PER_TOKEN).floor(), // a lone/short space run is free
        Cat::Other => (len / SYMBOLS_PER_TOKEN).ceil(),
    }
}

/// countTokens — deterministic single pass, no regex, no intermediate allocation (streaming-safe
/// on multi-MB strings). Markedly better than bytes/4 on code: it counts operators, snake_case
/// underscores and newlines that bytes/4 blurs away.
pub fn count_tokens(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    let mut tokens = 0.0;
    let mut run_cat: Option<Cat> = None;
    let mut run_len = 0.0;
    for c in text.encode_utf16() {
        // Newlines are counted individually (each ≈ 1 token) and never join a run.
        if c == 10 || c == 13 {
            if run_len > 0.0 {
                tokens += run_tokens(run_cat.expect("run has a category"), run_len);
                run_len = 0.0;
                run_cat = None;
            }
            tokens += 1.0;
            continue;
        }
        let cat = categorize(c);
        if run_cat == Some(cat) {
            run_len += 1.0;
        } else {
            if run_len > 0.0 {
                tokens += run_tokens(run_cat.expect("run has a category"), run_len);
            }
            run_cat = Some(cat);
            run_len = 1.0;
        }
    }
    if run_len > 0.0 {
        tokens += run_tokens(run_cat.expect("run has a category"), run_len);
    }
    tokens
}

/// estimateTokensFromBytes — bytes/4 for byte-only sites. LAYOUT DIVERGENCE FROM THE TS, stated
/// rather than hidden: there the definition lives in tokenEstimator and generatedFiles
/// re-exports it; here it already existed as `generated_files::estimate_tokens_from_bytes`
/// (u64 `div_ceil(4)` — identical semantics on the byte counts it takes), so this re-exports
/// THAT rather than adding a second definition. One fact, one definition; only the file it
/// sits in differs.
pub use crate::generated_files::estimate_tokens_from_bytes;

/// The calibration verdict: per-input counts aligned with `raw`, plus how they were obtained.
pub struct CalibrationResult {
    pub tokens: Vec<f64>,
    pub source: &'static str, // 'calibrated' | 'estimated'
}

/// calibrateTokens — THE key accuracy move. Given raw per-block estimates and the EXACT total
/// for their group, scale proportionally so the sum equals the exact total, removing the
/// estimator's systematic drift.
///
/// It REFUSES (returns the raw estimates, labeled 'estimated') with no exact total, or when the
/// required scale falls outside [min_scale, max_scale]. That guard is load-bearing: a group
/// whose blocks are STRUCTURALLY INCOMPLETE relative to the measured total (visible input blocks
/// that exclude the cached prefix / implicit system prompt) would otherwise have those invisible
/// tokens misattributed onto the visible ones. Inside the band the discrepancy is estimator
/// drift and scaling is honest; outside it the blocks simply do not cover the total, so keeping
/// the raw estimate and labeling it 'estimated' is the truthful answer rather than a lie.
pub fn calibrate_tokens(raw: &[f64], exact_total: Option<f64>, min_scale: Option<f64>, max_scale: Option<f64>) -> CalibrationResult {
    if raw.is_empty() {
        return CalibrationResult { tokens: Vec::new(), source: "estimated" };
    }
    let sum: f64 = raw.iter().sum();
    let estimated = || CalibrationResult { tokens: raw.to_vec(), source: "estimated" };
    let Some(exact) = exact_total.filter(|e| *e > 0.0) else { return estimated() };
    if sum <= 0.0 {
        return estimated();
    }
    let scale = exact / sum;
    let min = min_scale.unwrap_or(0.0);
    let max = max_scale.unwrap_or(f64::INFINITY);
    if scale < min || scale > max {
        return estimated();
    }
    let mut scaled: Vec<f64> = raw.iter().map(|r| crate::summarize::helpers::js_math_round(r * scale)).collect();
    // Rounding leaves a residual; fold it into the LARGEST block so the group sums EXACTLY to
    // the measured total (the acceptance invariant) with the least visual distortion. Strict `>`
    // keeps the FIRST maximum, as the TS loop does.
    let diff = exact - scaled.iter().sum::<f64>();
    if diff != 0.0 {
        let mut idx = 0;
        for i in 1..scaled.len() {
            if scaled[i] > scaled[idx] {
                idx = i;
            }
        }
        scaled[idx] = (scaled[idx] + diff).max(0.0);
    }
    CalibrationResult { tokens: scaled, source: "calibrated" }
}
