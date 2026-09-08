// src/cli/reviewGateTriggers.ts — WHAT ARMS the review gate (TRDD-0E3W5C45).
//
// Owner directive 2026-09-08: arm only on (a) a code/architecture/.md proposal or (b) a true write
// or commit. The previous predicate — every assistant text block is work — livelocked idle turns:
// a heartbeat's mandated `janitor heartbeat` line armed it, every reply to the block re-armed it,
// and one session spent ~40 blocked turns and 5 review forks over zero edits and zero commits.
//
// FAIL CLOSED ON TARGETS. A command STRING cannot prove what a command writes (`> "$REPORT_FILE"`,
// `cd x && > y`). The question asked here is the decidable one — is every write target a LITERAL
// path under an ephemeral root? — and anything undecidable ARMS. A false arm costs one fork; a
// false release is an unreviewed write.
//
// FAIL OPEN ON COMMANDS THE TOKENIZER DOES NOT MODEL, and say so: a script's own writes
// (`uv run x.py`, `./deploy.sh`) are invisible, and an unspaced `cmd>file` is one word. The
// separator set below is the weakest link — a shape it does not split (review 2026-09-08 found
// newlines and `$(…)` missing, then `do`/`then`/`{` as segment heads, each of which silently
// released a `git commit` inside it) is a skipped review that announces nothing.
// ponytail: string classification, not effects. Upgrade path if script writes ever matter:
// fingerprint `git status --porcelain` + HEAD between consecutive Stops.

import * as path from 'path'

export type ArmCause = 'edit' | 'write-shaped command' | 'proposal text'

/** A text block is a proposal iff a line STARTS with `PROPOSAL` (bold or heading allowed).
 *  Case-sensitive so prose ("my proposal is…") never counts. Fenced code does NOT arm: the
 *  harness style puts every command and every error dump in a fence, so a fence rule re-creates
 *  the idle-turn livelock one notch down. The marker is a self-report (propose-then-review rule);
 *  an unmarked proposal goes unreviewed by its author's omission — the owner's chosen trade over
 *  an LLM classifier on every Stop (round-2 review, 2026-09-08). */
export const PROPOSAL_LINE = /^[ \t]*(?:\*\*|#{1,6}[ \t]*)?PROPOSAL\b/m
export const textArms = (text: string): boolean => PROPOSAL_LINE.test(text)

export interface Word { word: string; quoted: boolean }

/** Shell words, quotes honoured, nothing expanded. Command-position boundaries — `|` `||` `&&`
 *  `;` a lone `&`, a NEWLINE, `(` `)` and a backtick — become a `;` word so `a|b`, a multi-line
 *  command and `X=$(git commit)` all put their commands in command position. `>&` and `>|` stay
 *  glued so `2>&1` is one fd-dup word and a clobber redirect is not read as a pipe into its target
 *  (it was: `>| src/a` reported `redirect into |`). An escaped character is marked quoted: `\;`
 *  must not split, `\>` must not redirect. */
export function shellWords(cmd: string): Word[] {
  const out: Word[] = []
  let cur = ''
  let quoted = false
  let q: string | null = null
  const flush = (): void => { if (cur !== '' || quoted) out.push({ word: cur, quoted }); cur = ''; quoted = false }
  const sep = (w: string): void => { flush(); out.push({ word: w, quoted: false }) }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q !== null) { if (c === q) q = null; else cur += c; continue }
    if (c === '"' || c === "'") { q = c; quoted = true; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; quoted = true; continue }
    // `!quoted`: a `>` that arrived quoted or escaped (`echo "a>"| tee x`) ends the word too, and
    // gluing the pipe onto it would swallow `tee` out of command position (review 2026-09-08).
    if ((c === '&' || c === '|') && cur.endsWith('>') && !quoted) { cur += c; continue }
    if (c === '|' || c === '&') {
      if (cmd[i + 1] === c) { sep(c + c); i++ } else sep(c)
      continue
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '(' || c === ')' || c === '`') { sep(';'); continue }
    if (/\s/.test(c)) { flush(); continue }
    cur += c
  }
  flush()
  return out
}

/** A LITERAL path under /dev/null, /tmp, /private/tmp, or the project's gitignored `reports/`
 *  and `*_dev/` dirs (INSIDE them — the dir itself is not exempt, so `rm -rf reports_dev` arms).
 *  Anything the shell would expand fails closed. Relative paths resolve against the hook's cwd —
 *  the SESSION cwd, so `cd elsewhere && > x` resolves wrong and arms (by design), and a session
 *  opened inside a subdirectory exempts that subdirectory's own `reports/` (accepted). */
export function isEphemeralTarget(target: string, cwd: string): boolean {
  if (target === '' || /[$`~*?{}[\]]/.test(target)) return false
  if (target === '/dev/null') return true
  const abs = path.resolve(cwd, target)
  if (abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/')) return true
  return /^(reports|[a-z]+_dev)\//.test(path.relative(cwd, abs))
}

// Exported as arrays so the tests can LOOP them: a hand-picked sample left most members untested
// (review 2026-09-08), and an untested alternation is one a refactor can drop unnoticed.
export const GIT_WRITE_SUBCOMMANDS = ['commit', 'push', 'pull', 'mv', 'rm', 'am', 'apply', 'checkout',
  'switch', 'restore', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'stash', 'clean', 'worktree']
export const GH_MUTATING_VERBS = ['create', 'comment', 'edit', 'review', 'merge', 'close', 'reopen', 'delete',
  'ready', 'lock', 'unlock', 'fork', 'checkout', 'upload', 'set', 'remove', 'run', 'rerun', 'cancel', 'sync',
  'transfer', 'rename', 'archive']
export const PKG_WRITE_VERBS = ['add', 'remove', 'uninstall', 'rm', 'un', 'link', 'unlink', 'publish', 'version']
const GIT_WRITE = new Set(GIT_WRITE_SUBCOMMANDS)
const GH_MUTATING = new Set(GH_MUTATING_VERBS)
const PKG_WRITE = new Set(PKG_WRITE_VERBS)
const GH_API_WRITE = /^(-X|--method|-f|-F|--field|--raw-field|--input)$/
// Prefix words that are not the command: wrappers, and the shell keywords that head a compound
// body or condition (`for …; do git commit; done` put `do` in command position and released the
// commit; `if git commit; then` and `while ! git push` did the same one review later).
const WRAPPERS = /^(sudo|env|time|nohup|nice|caffeinate|exec|command|xargs|if|while|until|!|do|then|else|elif|\{|\})$/
const SHELLS = /^(bash|sh|zsh|dash|ksh)$/
export const ALL_ARGS_ARE_TARGETS = ['tee', 'rm', 'touch']
export const LAST_ARG_IS_TARGET = ['cp', 'mv', 'rsync', 'ln', 'install']

/** `via` names the launcher (`xargs`, `find -exec`) when the targets are not in this segment's text. */
function segmentWriteReason(base: string, args: string[], via: string | null, cwd: string): string | null {
  const flagless = args.filter((a) => !a.startsWith('-'))
  if (base === 'git') {
    let j = 0 // skip global options; `-C dir` / `-c k=v` / `--git-dir x` take a value
    while (j < args.length && args[j].startsWith('-')) j += /^(-C|-c|--git-dir|--work-tree)$/.test(args[j]) ? 2 : 1
    const sub = args[j] ?? ''
    if (!GIT_WRITE.has(sub)) return null
    if ((sub === 'stash' || sub === 'worktree') && /^(list|show)$/.test(args[j + 1] ?? '')) return null
    return `git ${sub}`
  }
  if (base === 'gh') {
    if (args[0] === 'api') return args.some((a) => GH_API_WRITE.test(a)) ? 'gh api (mutating)' : null
    return GH_MUTATING.has(args[1] ?? '') ? `gh ${args[0]} ${args[1]}` : null
  }
  // A shell given a command STRING runs it; classify the string, not the shell. Quoting hid
  // `bash -c 'git commit'` from the segmenter (review 2026-09-08).
  if (SHELLS.test(base)) {
    const c = args.indexOf('-c')
    return c >= 0 && args[c + 1] !== undefined ? commandWriteReason(args[c + 1], cwd) : null
  }
  if (base === 'eval') return commandWriteReason(args.join(' '), cwd)
  if (base === 'sed' && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))) return 'sed -i'
  if (base === 'perl' && args.some((a) => /^-p?i/.test(a))) return 'perl -i'
  if (/^(npm|pnpm|yarn|bun|cargo|uv)$/.test(base)) {
    const sub = args[0] ?? ''
    if (PKG_WRITE.has(sub)) return `${base} ${sub}`
    return /^(install|i)$/.test(sub) && flagless.length > 1 ? `${base} install <pkg>` : null
  }
  if (base === 'agentlenspro' && !args.includes('--dry-run') && args.some((a) => a === 'setup' || /^--(un)?install-/.test(a))) return 'agentlenspro config write'
  if (base === 'memgrep' && /-mem-/.test(args[0] ?? '')) return `memgrep ${args[0]}`
  // `find -exec <cmd>` runs <cmd> once per hit and `-delete` unlinks the hits: both are writes
  // the command word `find` hides (review 2026-09-08 — `find . -exec rm {} \;` released).
  // EVERY `-exec`, each through the wrapper walk: `-exec ls {} \; -exec rm {} \;` and
  // `-exec sudo rm` both released when only the first one's next word was classified.
  if (base === 'find') {
    if (args.includes('-delete')) return 'find -delete'
    for (let e = 0; e < args.length; e++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[e])) continue
      const r = classifyCommand(args.slice(e + 1).map((word) => ({ word, quoted: false })), 'find -exec', cwd)
      if (r !== null) return r
    }
    return null
  }
  if (ALL_ARGS_ARE_TARGETS.includes(base) || LAST_ARG_IS_TARGET.includes(base)) {
    if (via !== null) return `${base} via ${via} (targets unknown)`
    const targets = ALL_ARGS_ARE_TARGETS.includes(base) ? flagless : flagless.slice(-1)
    const bad = targets.find((t) => !isEphemeralTarget(t, cwd))
    return bad === undefined ? null : `${base} ${bad}`
  }
  return null
}

/** The command word of one segment (after wrappers, env assignments and a wrapper's own
 *  options), classified. A quoted word in command position is not a command. */
function classifyCommand(words: Word[], via: string | null, cwd: string): string | null {
  let i = 0
  let inWrapper = false
  while (i < words.length && !words[i].quoted) {
    const w = words[i].word
    if (WRAPPERS.test(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      inWrapper = WRAPPERS.test(w)
      if (w === 'xargs') via = 'xargs'
    } else if (inWrapper && (w.startsWith('-') || w === '{}')) {
      // a wrapper's own option (`xargs -0 rm`, `xargs -I {} rm {}`) — `-0` was taken as the
      // command and released the rm. Only xargs's short value-taking options skip their SEPARATE
      // value (`xargs -n 1 rm`); never generically — `sudo -n` takes none, and a generic skip
      // would eat the command. Long forms (`--max-args 1`) and other wrappers' values
      // (`sudo -u x cmd`, `nice -n 10 cmd`) are still taken as the command: unmodelled, fail-open.
      if (via === 'xargs' && /^-[nPLIEdsa]$/.test(w)) i++
    } else break
    i++
  }
  if (i >= words.length || words[i].quoted) return null
  return segmentWriteReason(path.basename(words[i].word), words.slice(i + 1).map((w) => w.word), via, cwd)
}

/** Why a shell command is a write, or null when its text shows only reads. Each segment's
 *  command word (after wrappers and env assignments) FIRST, then redirects anywhere (`>`, `>>`,
 *  `>|`, attached or spaced; `2>&1`/`>&2` are fd dups, not files) — in that order so a heredoc
 *  commit whose body holds a bare `>` is reported as the commit it is, not as a redirect. */
export function commandWriteReason(cmd: string, cwd: string): string | null {
  const words = shellWords(cmd)
  const segments: Word[][] = [[]]
  for (const w of words) {
    if (!w.quoted && /^(\||\|\||&&|;|&)$/.test(w.word)) segments.push([])
    else segments[segments.length - 1].push(w)
  }
  for (const seg of segments) {
    const reason = classifyCommand(seg, null, cwd)
    if (reason !== null) return reason
  }
  for (let i = 0; i < words.length; i++) {
    if (words[i].quoted) continue
    const m = /^\d*(?:>\||>>?)(.*)$/.exec(words[i].word)
    if (!m || m[1].startsWith('&')) continue
    const target = m[1] !== '' ? m[1] : (words[i + 1]?.word ?? '')
    if (!isEphemeralTarget(target, cwd)) return `redirect into ${target || '(no target)'}`
  }
  return null
}
