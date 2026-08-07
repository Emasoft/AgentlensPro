// How Claude Code names a project's log directory under ~/.claude/projects — the ONE place that
// knows it. Three copies of this rule had grown (cacheEventLog, burnSeismic, causingToolCall); they
// agreed by luck rather than by construction, and each would have had to be found and fixed
// separately when Claude Code changed the rule. It has now changed once.
//
// The rule, MEASURED against Claude Code 2.1.224 rather than assumed (a real session run from a
// 237-char path, and the directory it produced):
//
//   - every non-alphanumeric character becomes '-'
//   - if that is longer than 200 characters, it is TRUNCATED to exactly 200 and a '-' plus a
//     6-character lowercase-alphanumeric hash is appended (observed: a 245-char slug became a
//     207-char directory ending '-4gwysy', whose first 200 chars were the naive slug's first 200).
//
// The hash is deliberately NOT reproduced here. It was not any of md5/sha1/sha256/sha512 over the
// path or the slug, in hex or base36, from either end — so any formula written now would be a
// guess that silently resolves to a directory that does not exist. Instead a long path is resolved
// by looking at what is actually ON DISK, which cannot drift from Claude Code's implementation
// because it IS Claude Code's output.
import * as fs from 'fs'
import { claudeProjectsDirs } from './logReader'

/** Claude Code truncates a project slug longer than this before appending its disambiguating hash. */
export const SLUG_MAX_LEN = 200

/** The naive derivation: every non-alphanumeric character becomes '-'. Accepts EITHER a path or an
 *  already-derived slug, so `--project` works with a path the user can type from memory or the slug
 *  they copied out of a previous report. This is correct on its own ONLY for a slug shorter than
 *  SLUG_MAX_LEN; at or beyond it, use resolveProjectSlugs. */
export function projectSlugOf(pathOrSlug: string): string {
  const value = pathOrSlug.trim()
  if (!value) return ''
  if (!value.includes('/') && !value.includes('\\')) return value
  return value.replace(/[^A-Za-z0-9]/g, '-')
}

/** The directory name(s) a path actually has on disk.
 *
 *  Short slugs (the overwhelming majority) return immediately without touching the disk — the naive
 *  derivation is exact there. Only a slug at or past the truncation boundary pays a readdir.
 *
 *  Returns MORE than one only when two projects' slugs share their first 200 characters — precisely
 *  the collision Claude Code's hash exists to break, and which a path alone therefore cannot break.
 *  Callers scanning for transcripts should scan them all: before this existed they derived an
 *  over-long name that could never match any directory and silently scanned NOTHING.
 *
 *  Falls back to the naive slug when nothing matches, so a path with no directory yet behaves as it
 *  always did instead of vanishing. */
export function resolveProjectSlugs(pathOrSlug: string, roots: string[] = claudeProjectsDirs()): string[] {
  const naive = projectSlugOf(pathOrSlug)
  // `<` not `<=`: a naive slug of exactly SLUG_MAX_LEN is indistinguishable from a truncated one, so
  // it must be checked against disk too. The match below accepts both shapes.
  if (naive.length < SLUG_MAX_LEN) return [naive]

  const head = naive.slice(0, SLUG_MAX_LEN)
  const found: string[] = []
  for (const root of roots) {
    let names: string[]
    try { names = fs.readdirSync(root) } catch { continue }
    for (const n of names) {
      // Either shape: the untruncated name itself, or head + '-' + hash.
      if (n === naive || (n.length > SLUG_MAX_LEN && n[SLUG_MAX_LEN] === '-' && n.startsWith(head))) {
        if (!found.includes(n)) found.push(n)
      }
    }
  }
  return found.length > 0 ? found : [naive]
}
