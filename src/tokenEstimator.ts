// TRDD-IQENK7JM — the ONE token-count source of truth for the whole codebase.
//
// We deliberately DO NOT add a BPE dependency (js-tiktoken et al.). js-tiktoken measures OpenAI's
// cl100k/o200k merges, NOT Claude's tokenizer — bundling it would buy false precision (and a
// supply-chain surface) while still being wrong for Claude. Instead we ship a small, deterministic,
// tiktoken-ISH segmenter that lands within ~±10-15% of real tokenizers on English/code, and — where
// the EXACT total is known from a usage bucket — we CALIBRATE the per-block estimates to that truth
// (see calibrateTokens). The calibrated numbers are then consistent with Claude's real tokenization
// regardless of the estimator's drift.

// How a count was obtained ('exact' | 'calibrated' | 'estimated') — the ONE declaration lives in
// src/shared/summarizerTypes.ts (it used to be re-declared here and in the webview, and the copies
// are exactly the drift class the shared-modules refactor removed).
import type { TokenSource } from './shared/summarizerTypes'

// ── The segmenter's tuning constants (justified per category) ─────────────────
// English prose averages ~4 chars/token INCLUDING the leading space; because we count whitespace
// separately (a lone inter-word space is free — it merges into the next BPE token), the WITHIN-word
// ratio is ~4.7 chars/token. Numbers tokenize ~3 digits/token. Runs of symbols merge (`=>`, `);`,
// `===`) so ~2 chars/token. Indentation/leading-space runs cost ~1 token per 4 spaces. CJK glyphs are
// ~1 token each. Every newline is ~1 token (load-bearing for multi-line code). These are the levers
// that make the estimate beat bytes/4 on code (more symbols/newlines → more tokens/byte) while
// staying ~bytes/4 on plain prose (where bytes/4 is already decent).
const LETTERS_PER_TOKEN = 4.7
const DIGITS_PER_TOKEN = 3
const SYMBOLS_PER_TOKEN = 2
const SPACES_PER_TOKEN = 4

const enum Cat { Other = 0, Letter = 1, Digit = 2, Space = 3, Cjk = 4 }

// Classify one UTF-16 code unit. Newlines are handled by the caller (each ≈ 1 token) so they are not
// a category here. Letters cover ASCII + the common Latin/Greek/Cyrillic ranges; exotic letters fall
// into Other (rare, small aggregate error). Surrogate halves (emoji, CJK-ext-B) read as Other.
function categorize(c: number): Cat {
  if (c >= 48 && c <= 57) return Cat.Digit
  if (c === 32 || c === 9) return Cat.Space // space, tab (newlines handled separately)
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return Cat.Letter // ASCII A-Z a-z
  if (c >= 0xc0 && c <= 0x2af) return Cat.Letter // Latin-1 supplement + Latin extended A/B
  if (c >= 0x370 && c <= 0x4ff) return Cat.Letter // Greek + Cyrillic
  if (
    (c >= 0x3040 && c <= 0x30ff) || // hiragana + katakana
    (c >= 0x3400 && c <= 0x9fff) || // CJK unified (incl. ext-A)
    (c >= 0xac00 && c <= 0xd7a3) || // hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0xff00 && c <= 0xffef) // fullwidth forms
  ) {
    return Cat.Cjk
  }
  return Cat.Other
}

// Tokens contributed by one homogeneous run of `len` chars of category `cat`.
function runTokens(cat: Cat, len: number): number {
  switch (cat) {
    case Cat.Letter: return Math.max(1, Math.round(len / LETTERS_PER_TOKEN))
    case Cat.Digit: return Math.max(1, Math.ceil(len / DIGITS_PER_TOKEN))
    case Cat.Cjk: return len
    case Cat.Space: return Math.floor(len / SPACES_PER_TOKEN) // a lone/short space run is free
    case Cat.Other: return Math.ceil(len / SYMBOLS_PER_TOKEN)
  }
}

/**
 * Estimate the token count of `text` with a deterministic, allocation-free single pass (streaming-safe
 * on multi-MB strings — no regex, no intermediate arrays). Lands within ~±10-15% of real tokenizers on
 * English/code; markedly better than bytes/4 on code (it counts operators, snake_case underscores, and
 * newlines that bytes/4 blurs away). Deterministic and side-effect-free so it is unit-testable.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  let runCat = -1 as number
  let runLen = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // Newlines are counted individually (each ≈ 1 token) and never join a run.
    if (c === 10 || c === 13) {
      if (runLen > 0) { tokens += runTokens(runCat as Cat, runLen); runLen = 0; runCat = -1 }
      tokens += 1
      continue
    }
    const cat = categorize(c)
    if (cat === runCat) {
      runLen++
    } else {
      if (runLen > 0) tokens += runTokens(runCat as Cat, runLen)
      runCat = cat
      runLen = 1
    }
  }
  if (runLen > 0) tokens += runTokens(runCat as Cat, runLen)
  return tokens
}

// bytes/4 token estimate for byte-only sites (a file we only stat'd, an aggregate byte total). Coarser
// than countTokens — use it ONLY when the actual text is not available. Kept at bytes/4 semantics
// (ceil, 0 for non-positive) so byte-only figures stay stable and the generatedFiles contract holds.
export function estimateTokensFromBytes(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / 4) : 0
}

export interface CalibrationResult {
  tokens: number[] // per-input calibrated (or passed-through) counts, aligned with `raw`
  source: TokenSource
}

/**
 * THE key accuracy move (TRDD-IQENK7JM spec §2). Given raw per-block estimates and the EXACT total for
 * their group (from a usage bucket / api_request), scale the estimates proportionally so their sum
 * equals the exact total — removing the estimator's systematic drift and making the per-block numbers
 * consistent with Claude's real tokenization. The result is labeled 'calibrated'.
 *
 * It refuses (returns the raw estimates, labeled 'estimated') when there is no exact total, or when the
 * required scale factor is OUTSIDE [minScale, maxScale]. That guard is load-bearing: a group whose
 * blocks are STRUCTURALLY INCOMPLETE relative to the measured total (e.g. a turn's visible input blocks
 * that do not include the cached prefix / the implicit system prompt) would otherwise have those
 * invisible tokens misattributed onto the visible blocks. Inside the band, the discrepancy is dominated
 * by estimator drift and scaling is honest; outside it, the blocks simply don't cover the total, so we
 * keep the raw estimate and label it 'estimated' rather than lie.
 */
export function calibrateTokens(
  raw: number[],
  exactTotal: number | undefined,
  opts: { minScale?: number; maxScale?: number } = {},
): CalibrationResult {
  if (raw.length === 0) return { tokens: [], source: 'estimated' }
  const sum = raw.reduce((a, b) => a + b, 0)
  if (exactTotal === undefined || exactTotal <= 0 || sum <= 0) return { tokens: raw.slice(), source: 'estimated' }
  const scale = exactTotal / sum
  const min = opts.minScale ?? 0
  const max = opts.maxScale ?? Infinity
  if (scale < min || scale > max) return { tokens: raw.slice(), source: 'estimated' }
  const scaled = raw.map(r => Math.round(r * scale))
  // Rounding leaves a small residual; fold it into the largest block so the group sums EXACTLY to the
  // measured total (the acceptance invariant) with the least visual distortion.
  const diff = exactTotal - scaled.reduce((a, b) => a + b, 0)
  if (diff !== 0) {
    let idx = 0
    for (let i = 1; i < scaled.length; i++) if (scaled[i] > scaled[idx]) idx = i
    scaled[idx] = Math.max(0, scaled[idx] + diff)
  }
  return { tokens: scaled, source: 'calibrated' }
}
