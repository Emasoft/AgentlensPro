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


/** A heredoc BODY (`<<EOF` … terminator line) is data the shell writes to stdin, not shell
 *  words — a body line reading `git commit -m x` must not arm, and `>=` inside prose must not
 *  read as a redirect (`redirect into =` — the false positive this exists to fix). Everything
 *  from the end of the operator line up to (and including) the terminator line is dropped;
 *  the operator line itself is kept untouched so a same-line redirect (`cat <<EOF > /abs/f`)
 *  still classifies normally. `<<-` strips leading tabs off the terminator line per shell rules.
 *  Multiple heredocs in one command are each consumed in the order their operators appear; an
 *  unterminated heredoc treats everything after it as body (fail toward dropping data, since
 *  unexecuted body text cannot itself be a write). */
const HEREDOC_OP_RE = /<<(-)?\s*(?:'([^']*)'|"([^"]*)"|([^\s'"<>;|&]+))/g
/** A heredoc BODY (`<<EOF` … terminator line) is data the shell writes to stdin, not shell
 *  words — a body line reading `git commit -m x` must not arm, and `>=` inside prose must not
 *  read as a redirect (`redirect into =` — the false positive this exists to fix). Everything
 *  from the end of the operator line up to (and including) the terminator line is dropped;
 *  the operator line itself is kept untouched so a same-line redirect (`cat <<EOF > /abs/f`)
 *  still classifies normally. `<<-` strips leading tabs off the terminator line per shell rules.
 *  The terminator match trims trailing whitespace and a trailing `\r` before comparing, so
 *  `<<'EOF'`, a padded terminator line (`EOF `), and a CRLF-terminated one all still terminate —
 *  a byte-exact-only match hides everything after it as unparsed body (review 2026-09-13: 4 of 5
 *  heredoc shapes broke exactly this way and released a later `git commit` as body data).
 *  A `<<` sitting inside an already-open quote (`bash -c 'cat <<EOF...'`) is not a real operator
 *  in THIS pass — it belongs to the quoted argument the outer shell just carries verbatim — so
 *  it is skipped here; `segmentWriteReason` re-enters this same classifier on that argument's
 *  own text and sees the heredoc for real.
 *  Multiple heredocs in one command are each consumed in the order their operators appear.
 *  FAIL OPEN vs FAIL CLOSED is a per-CALLER choice (`failOpen`), because an unterminated heredoc
 *  is evidence we failed to PARSE it, not evidence the rest of the line is safe to drop: the
 *  classification pass needs `failOpen=true` — a `git commit` sitting past an unparsed heredoc
 *  must still arm — while the noisy redirect scan needs `failOpen=false`, dropping the unparsed
 *  region so leftover `>=`/`->` inside genuinely-unclosed document text can't false-positive a
 *  redirect (commit 74b24905's fix). */
export function stripHeredocBodies(cmd: string, failOpen: boolean): string {
  const quoted = new Uint8Array(cmd.length)
  {
    let q: string | null = null
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i]
      if (q !== null) { quoted[i] = 1; if (c === q) q = null; continue }
      if (c === '"' || c === "'") { q = c; quoted[i] = 1; continue }
      if (c === '\\' && i + 1 < cmd.length) { quoted[i] = 1; quoted[i + 1] = 1; i++; continue }
    }
  }
  const lines = cmd.split('\n')
  const lineStart: number[] = []
  { let off = 0; for (const l of lines) { lineStart.push(off); off += l.length + 1 } }
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const base = lineStart[i]
    kept.push(line)
    i++
    HEREDOC_OP_RE.lastIndex = 0
    let m: RegExpExecArray | null
    const delimiters: { delim: string; strip: boolean }[] = []
    while ((m = HEREDOC_OP_RE.exec(line)) !== null) {
      if (quoted[base + m.index]) continue // `<<` inside a quote — not a real operator here
      const delim = m[2] ?? m[3] ?? m[4]
      if (delim !== undefined) delimiters.push({ delim, strip: m[1] === '-' })
    }
    for (const { delim, strip } of delimiters) {
      let terminated = false
      let j = i
      while (j < lines.length) {
        const raw = lines[j]
        const bodyLine = (strip ? raw.replace(/^\t+/, '') : raw).replace(/\r$/, '').replace(/[ \t]+$/, '')
        j++
        if (bodyLine === delim) { terminated = true; break }
      }
      // On failure to terminate, `kept` already holds every EARLIER heredoc's body correctly
      // stripped (that stripping happened incrementally, before we ever reached this one) plus
      // this operator line itself. failOpen must extend that same prefix with the raw undecidable
      // tail (`lines.slice(i)`), never discard `kept` and fall back to the original untouched
      // `cmd` — doing so re-exposed an EARLIER, already-terminated heredoc's body as live shell
      // text to the classification pass, inflating its segment count relative to the redirect
      // pass (which still strips that earlier heredoc via `kept`) and desyncing the two passes'
      // segIdx counters enough to resolve a `$VAR` redirect against a STALE assignment — a real
      // write silently released (found by adversarial review of TRDD segidx-desync, 2026-09-13:
      // `S=/tmp/fake\ncat <<A\nx ; y ; z\nA\nS=/repo/real\ncat <<EOF > $S\nbody` resolved `$S` to
      // the stale `/tmp/fake` and returned null instead of arming).
      if (!terminated) return failOpen ? kept.concat(lines.slice(i)).join('\n') : kept.join('\n')
      i = j
    }
  }
  return kept.join('\n')
}

/** A LITERAL path under /dev/null, /tmp, /private/tmp, or the project's gitignored `reports/`
 *  and `*_dev/` dirs (INSIDE them — the dir itself is not exempt, so `rm -rf reports_dev` arms).
 *  Anything the shell would expand fails closed. Relative paths resolve against the hook's cwd —
 *  the SESSION cwd, so `cd elsewhere && > x` resolves wrong and arms (by design), and a session
 *  opened inside a subdirectory exempts that subdirectory's own `reports/` (accepted). */
export function isEphemeralTarget(target: string, cwd: string): boolean {
  if (target === '' || /[$`~*?{}[\]]/.test(target)) {
    // `$$`/`$RANDOM` under a literal /tmp prefix are still decidable: both expand to DIGITS,
    // which cannot contain `/`, so they cannot escape the prefix — strip them and re-check the
    // remainder for any other shell metachar before resolving.
    if (/^\/(?:private\/)?tmp\//.test(target)) {
      const stripped = target.replace(/\$\$|\$RANDOM/g, '')
      if (!/[$`~*?{}[\]]/.test(stripped)) {
        const abs = path.resolve(cwd, stripped)
        if (abs.startsWith('/tmp/') || abs.startsWith('/private/tmp/')) return true
      }
    }
    return false
  }
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
// A redirect operator, attached or bare (`>file`/`>`), fd dups included (`2>&1`) — used to strip
// redirect words out of a segment's ARGUMENTS before classification. `cargo install --list
// 2>/dev/null` must not count `2>/dev/null` as a second package name (review 2026-09-09).
const REDIRECT_WORD_RE = /^\d*(?:>\||>>?|<{1,3})/
// Only a segment where EVERY word is `NAME=value` is a real shell assignment prefix — `export
// S=x`, `local S=x`, `declare S=x` are each a two-word segment whose first word (`export`/
// `local`/`declare`) fails this test, so they are deliberately NOT collected (fail closed:
// their effective value is unmodelled, so a use of `$S` after them must stay undecidable).
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
/** Resolves a word that is EXACTLY `$NAME`/`${NAME}` to a same-command literal assignment
 *  recorded STRICTLY BEFORE `segIdx` (shell semantics: `$S` expands before a same-segment
 *  prefix assignment applies — `S=/tmp/b tee "$S"` reads the OLD value of S, and an assignment
 *  only takes effect for LATER segments). Any other shape (`$NAME/sub`, `$(mktemp)`,
 *  `${NAME:-x}`) is returned unchanged — undecidable, so it stays undecidable and arms. */
type Resolve = (word: string, segIdx: number) => string

/** `via` names the launcher (`xargs`, `find -exec`) when the targets are not in this segment's text. */
function segmentWriteReason(base: string, args: string[], via: string | null, cwd: string, resolve: Resolve, segIdx: number): string | null {
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
      const r = classifyCommand(args.slice(e + 1).map((word) => ({ word, quoted: false })), 'find -exec', cwd, resolve, segIdx)
      if (r !== null) return r
    }
    return null
  }
  if (ALL_ARGS_ARE_TARGETS.includes(base) || LAST_ARG_IS_TARGET.includes(base)) {
    if (via !== null) return `${base} via ${via} (targets unknown)`
    const targets = ALL_ARGS_ARE_TARGETS.includes(base) ? flagless : flagless.slice(-1)
    // `resolve` turns a same-command literal `$VAR` target into its recorded value before the
    // ephemeral check; the reported message still names the original text (`t`), not the value.
    const bad = targets.find((t) => !isEphemeralTarget(resolve(t, segIdx), cwd))
    return bad === undefined ? null : `${base} ${bad}`
  }
  return null
}

/** The command word of one segment (after wrappers, env assignments and a wrapper's own
 *  options), classified. A quoted word in command position is not a command. */
function classifyCommand(words: Word[], via: string | null, cwd: string, resolve: Resolve, segIdx: number): string | null {
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
  return segmentWriteReason(path.basename(words[i].word), words.slice(i + 1).map((w) => w.word), via, cwd, resolve, segIdx)
}

/** Why a shell command is a write, or null when its text shows only reads. Each segment's
 *  command word (after wrappers and env assignments) FIRST, then redirects anywhere (`>`, `>>`,
 *  `>|`, attached or spaced; `2>&1`/`>&2` are fd dups, not files) — in that order so a heredoc
 *  commit whose body holds a bare `>` is reported as the commit it is, not as a redirect. */
export function commandWriteReason(cmd: string, cwd: string): string | null {
  // `words` drives CLASSIFICATION (does this contain a `git commit`-shaped write?) and must
  // fail OPEN on a heredoc we can't parse — losing the command text would hide a real write.
  const words = shellWords(stripHeredocBodies(cmd, true))
  // Segments used for CLASSIFICATION only: separator words split them, and every unquoted
  // redirect word is dropped (its attached operand with it; a BARE operator's separate spaced
  // operand is dropped too) so a redirect never counts as a command argument. `words` itself is
  // left untouched — the redirect pass below still walks it to find real write targets.
  const segments: Word[][] = [[]]
  for (let idx = 0; idx < words.length; idx++) {
    const w = words[idx]
    if (!w.quoted && /^(\||\|\||&&|;|&)$/.test(w.word)) { segments.push([]); continue }
    if (!w.quoted) {
      const m = REDIRECT_WORD_RE.exec(w.word)
      if (m !== null) {
        if (w.word.slice(m[0].length) === '') idx++ // bare operator: its spaced operand isn't an argument either
        continue
      }
    }
    segments[segments.length - 1].push(w)
  }

  // Same-command literal `VAR=value` assignments resolve a later `$VAR`/`${VAR}` write target —
  // but only POSITIONALLY: the shell expands `$VAR` at the point of use BEFORE a same-segment
  // prefix assignment applies (`S=/tmp/b tee "$S"` reads the OLD value), and an assignment takes
  // effect only for segments AFTER the one that defines it. A segment counts as a real
  // assignment prefix only when EVERY one of its words is `NAME=value` (a pure-assignment
  // segment like `S=/tmp/a;` or `S=/tmp/a &&`) — one with a command after the assignment words
  // (`S=/tmp/b tee …`) records nothing, because that VAR is not yet set for anything in THIS
  // segment. `cumulative[i]` is the literal map as of the START of segment `i` (segments
  // 0..i-1 applied); a later reassignment whose value is not itself a plain literal deletes the
  // entry rather than keeping the stale value, so it still fails closed.
  const cumulative: Map<string, string>[] = [new Map()]
  for (const seg of segments) {
    const next = new Map(cumulative[cumulative.length - 1])
    if (seg.every((w) => ASSIGNMENT_RE.test(w.word))) {
      for (const w of seg) {
        const m = ASSIGNMENT_RE.exec(w.word) as RegExpExecArray
        if (/[$`~*?{}[\]]/.test(m[2])) next.delete(m[1])
        else next.set(m[1], m[2])
      }
    }
    cumulative.push(next)
  }
  const resolve: Resolve = (word, segIdx) => {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(word)
    if (m === null) return word
    return cumulative[segIdx]?.get(m[1]) ?? word
  }

  for (let idx = 0; idx < segments.length; idx++) {
    const reason = classifyCommand(segments[idx], null, cwd, resolve, idx)
    if (reason !== null) return reason
  }
  // The redirect scan is the noisy pass (any bare `>` anywhere counts), so it takes the FAIL
  // CLOSED strip instead: an unterminated heredoc has its unparsed region dropped rather than
  // scanned, so leftover `>=`/`->` inside genuinely-unclosed document text can't false-positive
  // a redirect (the false positive commit 74b24905 fixed). `segIdx` counts the same separator
  // words the segment builder split on, so it names the same segment as the classification pass
  // in the common (terminated-heredoc) case where `redirectWords` and `words` agree; they can
  // diverge only on a genuinely unterminated heredoc, where `resolve` falls back to the raw word
  // via its own out-of-range guard. Sole other divergence: a bare operator whose operand is
  // itself a separator (`> ; foo`) — the builder swallows it as the operand. Harmless: this pass
  // takes `;` as the redirect TARGET first and arms before it can count the `;` as a separator —
  // unless cwd is under /tmp, where the count diverges unobservably (nothing later reads the
  // snapshot) on a command the shell rejects as a syntax error anyway.
  const redirectWords = shellWords(stripHeredocBodies(cmd, false))
  let segIdx = 0
  for (let i = 0; i < redirectWords.length; i++) {
    if (!redirectWords[i].quoted && /^(\||\|\||&&|;|&)$/.test(redirectWords[i].word)) { segIdx++; continue }
    if (redirectWords[i].quoted) continue
    const m = /^\d*(?:>\||>>?)(.*)$/.exec(redirectWords[i].word)
    if (!m || m[1].startsWith('&')) continue
    const target = m[1] !== '' ? m[1] : (redirectWords[i + 1]?.word ?? '')
    if (!isEphemeralTarget(resolve(target, segIdx), cwd)) return `redirect into ${target || '(no target)'}`
  }
  return null
}
