// Mirror of src/tokenEstimator.ts (TRDD-IQENK7JM). The webview cannot import Node/host code, so the
// segmenter is hand-mirrored here (same constants, same categories) — keep the two in sync. The
// webview only needs the client-side ESTIMATORS: the host already CALIBRATES the per-block counts it
// ships (ContextBlock.tokens/tokenSource) against the exact usage totals, so calibrateTokens lives
// host-side only. These estimators are for the webview's OWN char/byte-length figures (blob lengths,
// file-I/O byte totals) that never round-trip to the host.
// (TokenSource is NOT declared here — the one declaration is src/shared/summarizerTypes.ts,
// re-exported by ./types; scripts/check-no-mirrors.js rejects a local copy.)

const LETTERS_PER_TOKEN = 4.7
const DIGITS_PER_TOKEN = 3
const SYMBOLS_PER_TOKEN = 2
const SPACES_PER_TOKEN = 4

const enum Cat { Other = 0, Letter = 1, Digit = 2, Space = 3, Cjk = 4 }

function categorize(c: number): Cat {
  if (c >= 48 && c <= 57) return Cat.Digit
  if (c === 32 || c === 9) return Cat.Space
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return Cat.Letter
  if (c >= 0xc0 && c <= 0x2af) return Cat.Letter
  if (c >= 0x370 && c <= 0x4ff) return Cat.Letter
  if (
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef)
  ) {
    return Cat.Cjk
  }
  return Cat.Other
}

function runTokens(cat: Cat, len: number): number {
  switch (cat) {
    case Cat.Letter: return Math.max(1, Math.round(len / LETTERS_PER_TOKEN))
    case Cat.Digit: return Math.max(1, Math.ceil(len / DIGITS_PER_TOKEN))
    case Cat.Cjk: return len
    case Cat.Space: return Math.floor(len / SPACES_PER_TOKEN)
    case Cat.Other: return Math.ceil(len / SYMBOLS_PER_TOKEN)
  }
}

// Estimate token count of `text` — deterministic single pass, ~±10-15% of real tokenizers, better than
// bytes/4 on code. Mirror of src/tokenEstimator.ts countTokens.
export function countTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  let runCat = -1 as number
  let runLen = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
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

// bytes/4 fallback for byte-only figures (file-I/O byte totals). Mirror of src/tokenEstimator.ts.
export function estimateTokensFromBytes(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / 4) : 0
}
