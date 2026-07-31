// src/capturedBody.ts — the shape of a captured raw API body, and how to read one off disk.
//
// WHY THIS IS ITS OWN MODULE. These declarations started inside `src/cli/ctxmapCli.ts`, which was
// fine while ctxmap was the only reader. `src/ctxVisual.ts` is core (not CLI) and needs the same
// shapes, and a core module importing from `cli/` is a layering inversion. The alternative — a
// second copy of the declarations — is exactly the drift this repo already fails builds over
// (`scripts/check-no-mirrors.js`, after two hand-synced copies of pricing/cacheBreak diverged in
// ways nobody noticed). So: one declaration, imported by both.
//
// The shapes are deliberately PARTIAL and every field optional. A captured body is whatever the API
// was actually sent, which is not under our control and gains fields without warning; a strict type
// would make an unrecognised-but-valid capture a crash instead of a slightly-less-detailed report.

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

export interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  thinking?: string
}
export interface Message { role?: string; content?: ContentBlock[] | string }
export interface ToolDef { name?: string; description?: string }
export interface RequestBody {
  model?: string
  system?: (ContentBlock | string)[]
  messages?: Message[]
  tools?: ToolDef[]
}

/** The response's FULL usage object, kept whole. The 5m/1h split decides the cache-write rate, so
 *  dropping it would discard the one number that turns tokens into money. */
export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  service_tier?: string
}

export interface ResponseBody { model?: string; usage?: Usage }

/** The API requires at least one message, so any prefix that ends inside `tools` or `system` needs a
 *  filler. It is one token, and every consumer differences it back out. */
export const PREFIX_STUB = { role: 'user', content: 'x' }

/** The decoded TEXT of a captured body, gunzipped when needed but NOT parsed.
 *
 *  Exists so a caller that only needs a substring test decodes exactly the same bytes `readBody`
 *  would parse. Reading the file with `fs.readFileSync(p, 'utf8')` instead silently mojibakes every
 *  gzipped capture, and a substring test then misses text that is really there — a false negative
 *  that looks identical to "not present". */
export function readBodyText(p: string): string {
  let raw = fs.readFileSync(p)
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw)
  return raw.toString('utf8')
}

/** Read a captured body, transparently gunzipping the compressed ones. */
export function readBody(p: string): unknown {
  const text = readBodyText(p)
  try {
    return JSON.parse(text)
  } catch (e) {
    // Name the file: a bare "Unexpected token" from a 900KB body is unactionable, and a
    // half-flushed capture is the normal way this fails.
    throw new Error(`${path.basename(p)} is not readable as a captured body: ${(e as Error).message}`)
  }
}

/** Every text a request carries, in canonical order, as flat strings. Used for substring tests
 *  (the ctxvis nonce) without each caller re-implementing the block walk. */
export function messageTexts(m: Message | undefined): string[] {
  if (!m) return []
  if (typeof m.content === 'string') return [m.content]
  if (!Array.isArray(m.content)) return []
  const out: string[] = []
  for (const b of m.content) {
    if (typeof b === 'string') { out.push(b); continue }
    if (b?.text) out.push(b.text)
    // A tool_use's input and a tool_result's content are text the model saw too, so a caller
    // searching for a marker must be able to find it there. JSON.stringify is the honest flattening:
    // it cannot miss a nested field the way a hand-written walk of `.content[].text` does.
    if (b?.input !== undefined) { try { out.push(JSON.stringify(b.input)) } catch { /* cyclic — skip */ } }
    if (b?.content !== undefined) { try { out.push(JSON.stringify(b.content)) } catch { /* cyclic — skip */ } }
  }
  return out
}
