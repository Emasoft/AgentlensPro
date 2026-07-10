#!/usr/bin/env node
// Anti-mirror guard: fails (exit 1) if any file under media/src DECLARES a top-level symbol
// whose name is exported by src/shared. The webview must IMPORT (or re-export) the shared
// modules, never re-declare them — hand-mirrored copies are exactly the drift class this repo
// removed in the shared-modules refactor (the media cacheBreak mirror had silently lost the
// FAST_MODE detection; the two pricing tables had diverged into different interfaces).
//
// Re-exports (`export { X } from ...`, `export type * from ...`) and imports are NOT
// declarations and never flagged. Wired into CI (after Lint) and `pnpm run check-mirrors`.
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHARED_DIR = path.join(ROOT, 'src', 'shared')
const MEDIA_DIR = path.join(ROOT, 'media', 'src')

// Strip comments and string/template-literal CONTENTS so brace counting and declaration
// matching never trip on braces or keywords inside strings. String delimiters are kept
// (replaced content) so the line structure and offsets stay stable.
function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  // template-literal nesting stack: each entry is the ${ depth of one template level
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {                    // line comment
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {                    // block comment (keep newlines for line numbers)
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++ }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {                       // plain string
      const quote = c
      out += quote; i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++                        // skip escaped char
        if (src[i] === '\n') out += '\n'
        i++
      }
      out += quote; i++
      continue
    }
    if (c === '`') {                                    // template literal (may nest via ${ ... })
      out += '`'; i++
      let done = false
      while (i < n && !done) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { out += '`'; i++; done = true; continue }
        if (src[i] === '$' && src[i + 1] === '{') {     // interpolation: recurse by brace counting
          out += '${'; i += 2
          let depth = 1
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            if (depth > 0) out += src[i] === '\n' ? '\n' : src[i]
            i++
          }
          out += '}'
          continue
        }
        if (src[i] === '\n') out += '\n'
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// Names exported by one src/shared file: declarations (`export interface X` …) plus
// local export lists (`export { a, b as c }` without a `from`).
function sharedExports(filePath) {
  const clean = stripCommentsAndStrings(fs.readFileSync(filePath, 'utf8'))
  const names = new Set()
  const declRe = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = declRe.exec(clean))) names.add(m[1])
  const listRe = /^\s*export\s*\{([^}]*)\}\s*(?!\s*from)/gm
  while ((m = listRe.exec(clean))) {
    for (const piece of m[1].split(',')) {
      const asMatch = piece.match(/(?:^|\s)as\s+([A-Za-z_$][\w$]*)\s*$/)
      const name = asMatch ? asMatch[1] : piece.trim().replace(/^type\s+/, '')
      if (name) names.add(name)
    }
  }
  return names
}

// Top-level declarations in one media/src file: brace/paren depth 0 only, so nested
// interfaces (e.g. inside `declare global {}`) and local consts inside functions are ignored.
function topLevelDeclarations(filePath) {
  const clean = stripCommentsAndStrings(fs.readFileSync(filePath, 'utf8'))
  const decls = []
  const lines = clean.split('\n')
  let brace = 0
  let paren = 0
  const declRe = /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(interface|type|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]
    if (brace === 0 && paren === 0) {
      const m = line.match(declRe)
      // `export type * from` / `export { } from` re-exports don't match declRe (no name follows
      // the keyword directly), and import lines don't start with a declaration keyword.
      if (m) decls.push({ name: m[2], line: ln + 1 })
    }
    for (const ch of line) {
      if (ch === '{') brace++
      else if (ch === '}') brace--
      else if (ch === '(') paren++
      else if (ch === ')') paren--
    }
  }
  return decls
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, exts, out)
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full)
  }
  return out
}

function main() {
  if (!fs.existsSync(SHARED_DIR)) {
    console.error(`check-no-mirrors: ${path.relative(ROOT, SHARED_DIR)} does not exist`)
    process.exit(1)
  }
  const shared = new Map() // name -> shared file that exports it
  for (const f of walk(SHARED_DIR, ['.ts'])) {
    for (const name of sharedExports(f)) shared.set(name, path.relative(ROOT, f))
  }
  if (shared.size === 0) {
    console.error('check-no-mirrors: src/shared exports nothing — the guard would be vacuous; failing loudly')
    process.exit(1)
  }

  const violations = []
  for (const f of walk(MEDIA_DIR, ['.ts', '.tsx'])) {
    for (const decl of topLevelDeclarations(f)) {
      if (shared.has(decl.name)) {
        violations.push(`${path.relative(ROOT, f)}:${decl.line}  declares '${decl.name}' (shared source: ${shared.get(decl.name)})`)
      }
    }
  }

  if (violations.length > 0) {
    console.error('check-no-mirrors: media/src re-declares symbols that src/shared already exports.')
    console.error('Import (or re-export) the shared module instead — mirrors drift.\n')
    for (const v of violations) console.error('  ' + v)
    process.exit(1)
  }
  console.log(`check-no-mirrors: OK — ${shared.size} shared exports, no mirrors under media/src`)
}

main()
