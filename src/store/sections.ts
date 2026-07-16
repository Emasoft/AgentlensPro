// Byte-exact sectioning of a raw API body (TRDD-K3WDPR7M Phase 2).
//
// WHY SECTION AT ALL: every LLM request re-sends the WHOLE conversation plus an identical ~342 KB
// `tools` array. Measured over 40 real bodies: 27.9 MB raw -> 2,069 unique sections. The bodies are
// ~86% pure repetition, so content-addressing the SECTIONS makes a repeat turn cost almost nothing
// (only the parts that actually changed are new).
//
// WHY BYTE OFFSETS AND NOT JSON.parse -> JSON.stringify: reconstruction must be BYTE-IDENTICAL to the
// source file, and a re-serialization round-trip only *happens* to be byte-exact — it rests on V8's
// key-order rules, its number formatting, and its string escaping all matching the producer's. That
// held for 25/25 sample bodies, which is exactly the kind of evidence that lulls you into shipping a
// corpus you cannot restore. So we never re-serialize: we slice the ORIGINAL text into spans and
// concatenate them back. Byte-identity is then true BY CONSTRUCTION, not by luck.
import { createHash } from 'crypto'

/** A span smaller than this stays inline as literal glue: a content-addressed row costs more (hash +
 *  index + row overhead) than it can ever save on a 20-byte scalar. Tuned to keep `model`, `stream`,
 *  `max_tokens` etc. inline while every message block and tool definition gets deduped. */
export const MIN_BLOB_BYTES = 128

/** One piece of a body. Concatenating every part's bytes, in order, reproduces the source EXACTLY. */
export type Part =
  /** Literal source bytes: punctuation, keys, and any value too small to be worth deduping. */
  | { kind: 'lit'; text: string }
  /** A content-addressed span. `path`/`idx`/`n` are the IN-CLEAR index the user asked for: they answer
   *  "what is in this context / what changed / what is growing" with ZERO decompression. */
  | { kind: 'blob'; sha: string; n: number; path: string; idx: number }

export interface Sectioned {
  parts: Part[]
  /** sha256 -> the exact span text. The caller writes these content-addressed (a repeat costs 0). */
  blobs: Map<string, string>
}

export function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** Skip JSON whitespace. */
function ws(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++
  return i
}

/**
 * Return the index just past the JSON value starting at `i`. A minimal scanner — it does NOT validate
 * the document (the producer is Claude Code, and a malformed body would fail the sha256 gate anyway);
 * it only needs to find the value's EXACT extent so we can slice it.
 *
 * The string case is the one that must be exactly right: a `"` inside a string, or a `{`/`[` inside
 * one, would otherwise desynchronize the whole scan. `\\` must be consumed as a unit, or a trailing
 * backslash before the closing quote (`"C:\\"`) would eat the quote and run off the end.
 */
export function scanValue(s: string, i: number): number {
  i = ws(s, i)
  const c = s[i]
  if (c === '"') {
    i++
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue } // an escape pair is ONE unit — never look at its second char
      if (s[i] === '"') return i + 1
      i++
    }
    throw new Error('unterminated string in JSON body')
  }
  if (c === '{' || c === '[') {
    const open = c
    const close = c === '{' ? '}' : ']'
    let depth = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '"') { i = scanValue(s, i); continue } // strings are opaque — braces inside don't count
      if (ch === open) depth++
      else if (ch === close) { depth--; if (depth === 0) return i + 1 }
      i++
    }
    throw new Error('unterminated object/array in JSON body')
  }
  // number | true | false | null — run to the next structural character.
  const start = i
  while (i < s.length && !',}] \n\r\t'.includes(s[i])) i++
  if (i === start) throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`)
  return i
}

/** Emit a span as a blob part (deduped) or as literal glue when it is too small to be worth a row. */
function emit(out: Sectioned, span: string, path: string, idx: number): void {
  const n = Buffer.byteLength(span, 'utf8')
  if (n < MIN_BLOB_BYTES) {
    out.parts.push({ kind: 'lit', text: span })
    return
  }
  const sha = sha256(span)
  out.blobs.set(sha, span) // a Map keyed by content IS the dedup — a repeat overwrites itself
  out.parts.push({ kind: 'blob', sha, n, path, idx })
}

/**
 * Split a raw body into parts. Top-level keys become sections; a top-level ARRAY is split
 * ELEMENT-WISE.
 *
 * The element-wise split is the load-bearing part and it must be GENERIC, not messages-only: the
 * `tools` array is 342 KB and byte-identical on EVERY request (172 items). A messages-only sectioner
 * would re-store those 342 KB every single turn and leave most of the redundancy on the table.
 */
export function sectionize(raw: string): Sectioned {
  const out: Sectioned = { parts: [], blobs: new Map() }
  let i = ws(raw, 0)
  if (raw[i] !== '{') {
    // Not a top-level object (shouldn't happen for an API body) — store it whole rather than guess.
    emit(out, raw, '$', -1)
    return out
  }

  let lit = i // start of the pending literal run (glue we copy through verbatim)
  i++ // past '{'
  for (;;) {
    i = ws(raw, i)
    if (raw[i] === '}') { out.parts.push({ kind: 'lit', text: raw.slice(lit) }); break }
    if (raw[i] === ',') { i++; continue }

    const keyEnd = scanValue(raw, i)          // the key string, quotes included
    const key = JSON.parse(raw.slice(i, keyEnd)) as string
    let j = ws(raw, keyEnd)
    if (raw[j] !== ':') throw new Error(`expected ':' after key ${key}`)
    j = ws(raw, j + 1)

    if (raw[j] === '[') {
      // Split the array element-wise. Everything that is NOT an element — '[', ',', ']', and any
      // whitespace between them — is copied through as literal glue by slicing the source, so the
      // original formatting survives exactly. (Emitting a synthesized ',' instead would drop the
      // surrounding whitespace: real API bodies are compact so it would never show, which is
      // precisely the kind of "happens to work" that makes a corpus unrecoverable the one day it
      // doesn't.)
      out.parts.push({ kind: 'lit', text: raw.slice(lit, j + 1) })
      let k = j + 1
      let glue = k // start of the pending glue run INSIDE the array
      let elem = 0
      for (;;) {
        const p = ws(raw, k)
        if (raw[p] === ']') { k = p + 1; break }   // trailing ws + ']' belong to the next glue run
        if (raw[p] === ',') { k = p + 1; continue } // stays in the glue run — do not synthesize it
        const end = scanValue(raw, p)
        out.parts.push({ kind: 'lit', text: raw.slice(glue, p) })
        emit(out, raw.slice(p, end), key, elem++)
        glue = end
        k = end
      }
      lit = glue // from the end of the last element (its trailing ws + ']') onward
      i = k
      continue
    }

    // A scalar or object value: glue up to it stays literal, the value itself is content-addressed.
    const end = scanValue(raw, j)
    out.parts.push({ kind: 'lit', text: raw.slice(lit, j) })
    emit(out, raw.slice(j, end), key, -1) // idx -1 = "not an array element"
    lit = end
    i = end
  }
  return out
}

/**
 * Rebuild the exact source text. `getBlob` resolves a sha256 to its span; a MISSING blob THROWS —
 * silently emitting a gap would hand back a corrupt body that still looks like JSON, and the caller
 * would persist that as truth. Fail loudly instead (the sha256 gate would catch it, but only after
 * the damage is on disk).
 */
export function reassemble(parts: Part[], getBlob: (sha: string) => string | undefined): string {
  let out = ''
  for (const p of parts) {
    if (p.kind === 'lit') { out += p.text; continue }
    const span = getBlob(p.sha)
    if (span === undefined) throw new Error(`missing blob ${p.sha} (${p.path}[${p.idx}], ${p.n} bytes)`)
    out += span
  }
  return out
}
