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

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export type ArmCause = 'edit' | 'write-shaped command' | 'proposal text' | 'worker write'

/** THE PROPOSAL MARKER (owner order 2026-09-15). A text block is a proposal iff a line STARTS with
 *  `PROPOSAL FOR ACTION - PLEASE REVIEW` (bold or heading prefix allowed; any dash). Case-sensitive,
 *  exact words, so prose about the protocol never counts. A proposal that lacks this line is NOT a
 *  proposal to the gate and triggers nothing on Stop or SubagentStop — the marker is a self-report,
 *  the owner's chosen trade over an LLM classifier on every Stop. Fenced code does NOT arm: the
 *  harness style puts every command and every error dump in a fence, so a fence rule re-creates
 *  the idle-turn livelock one notch down. */
export const PROPOSAL_MARKER = 'PROPOSAL FOR ACTION - PLEASE REVIEW'
export const PROPOSAL_LINE = /^[ \t]*(?:\*\*|#{1,6}[ \t]*)?PROPOSAL FOR ACTION [-–—] PLEASE REVIEW\b/m
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

/** A DECLARED-ROLE worker's write target the classifier cannot resolve, whose STATIC directory is nevertheless
 *  ephemeral — so the write is that role's report or scratch output. TRDD-QQ2XIIZ6, round-2 review amendment A:
 *  a role (`ROLE: MEASURE|REVIEW|INVESTIGATE`, read by reviewGate's workerDeclaredRole) relaxes ONLY the fail-closed
 *  rule for UNRESOLVABLE targets; a resolvable write outside the ephemeral dirs (a role fork writing `src/a.ts`)
 *  still demands review, so labelling a worker a role never switches review off for its real writes.
 *  Unresolvable = still holds `$` or a backtick after the same-command literal assignments were applied (a
 *  `$(date +%s)` stamp, a `for i …` loop variable). Exempt only when (1) the text before the first `$` or backtick,
 *  cut at its last `/`, is a non-empty directory that is itself ephemeral (judged by isEphemeralTarget on a probe
 *  file inside it, after normalising `..`), and (2) the DYNAMIC remainder from that `$` or backtick holds no `/`,
 *  no `..` and no backslash.
 *  WHY a CONTENT rule (review of 668fc421): the danger is what the dynamic part can expand to, not its syntax. A
 *  `/` lets it climb or descend (the round-1 review's `$(printf ../src)/a.ts`); `..` as a whole name is the parent
 *  directory itself (`rm -rf "reports/$(printf ..)"` removes the project); a backslash escape spells either without
 *  writing it (`'..\57src\57a.ts'`, `'\56\56'`). One rule covers `$(…)` and backtick spans alike, so a backtick
 *  stamp (`docs_dev/`date +%s`-r.md`) passes like `$(date +%s)` does. Only a QUOTED backtick span reaches here
 *  whole: shellWords treats an unquoted backtick as a command separator, so the target word ends AT the backtick
 *  and the span's text becomes its own segment — a gap for every caller, not only roles (recorded on TRDD-QQ2XIIZ6).
 *  Accepted residual: a dynamic part whose OUTPUT is computed rather than spelled — an unassigned or runtime
 *  variable, a computed `X=$(…)`, a `for X in …` loop variable, `$(cat f)`, `$(printf %s%s . .)` — can still
 *  expand to `..` or `../`; only a declared-role worker can use it. */
export function isRoleScratchTarget(target: string, cwd: string): boolean {
  const cut = target.search(/[$`]/)
  if (cut < 0) return false
  if (/[/\\]|\.\./.test(target.slice(cut))) return false
  const dir = target.slice(0, target.lastIndexOf('/', cut) + 1)
  if (dir === '' || /[~*?{}[\]]/.test(dir)) return false
  return isEphemeralTarget(path.join(dir, '_'), cwd)
}

/** WHY: `(` is a shellWords separator, so an UNQUOTED `docs_dev/$(date +%s)-r.md` reaches the target checks as
 *  `docs_dev/$` — the substitution and everything after its `)` are out of sight, and that is exactly where the
 *  round-1 review's `$(printf ../src)/a.ts` puts its `/`, so isRoleScratchTarget's no-`/` rule alone would pass
 *  it (TRDD-QQ2XIIZ6). For a target the tokenizer cut there (it ends in `$`), the RAW command must show EVERY
 *  `<target>(` as a flat substitution — no nested paren, quote, backslash or backtick — holding no `/`, then a word
 *  tail holding none, then the word's end; and neither may hold `..`, the content rule isRoleScratchTarget cannot
 *  apply to text it never sees (`rm -rf reports/$(printf ..)` removes the project). Anything else fails closed. */
export function isFlatCutSubstitution(cmd: string, target: string): boolean {
  const opens = cmd.split(`${target}(`).length - 1
  if (opens === 0) return false
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flat = new RegExp(`${esc}\\([^()'"\\\\\`/]*\\)[^\\s;&|<>()'"\\\\\`/]*(?=$|[\\s;&|<>()])`, 'g')
  const found = cmd.match(flat) ?? []
  return found.length === opens && found.every((m) => !m.includes('..', target.length))
}

/** The value a same-command `D=$(mktemp …)` records in commandWriteReasons' assignment map: not a path (mktemp's
 *  output is unknowable here, and on macOS it is under /var/folders, not /tmp), only a mark isMktempTarget reads. */
const MKTEMP: unique symbol = Symbol('mktemp')
const MKTEMP_FLAGS = String.raw`(?:[ \t]+(?:-[dq]{1,2}|-t[ \t]+[A-Za-z0-9._-]+))*`

/** Whether the assignment word `name=value` of a pure-assignment segment stores a fresh mktemp path.
 *  WHY (review of 668fc421): role forks write scratch as `D=$(mktemp -d); cat > "$D/x"`, which armed the gate
 *  because `$D` is unresolvable and has no static directory. Unquoted `D=$(mktemp -d)` reaches here cut as `D=$`
 *  (the `(` is a separator) with `mktemp` heading the NEXT segment; quoted `D="$(mktemp -d)"` arrives whole. Either
 *  way the RAW command decides, and fails closed unless EVERY bare mention of `name` is such an assignment (a second
 *  assignment, `for D in`, `read D`, `D+=` or `export D` disqualifies it), with only `-d`, `-q` and `-t <prefix>` —
 *  never a template argument (one with no `/` is created in the CWD), `-p` or `--tmpdir` — and nothing in the
 *  command names TMPDIR, which would move mktemp's directory. */
function isMktempAssignment(cmd: string, name: string, value: string, quoted: boolean, nextSeg: Word[] | undefined): boolean {
  const cutShape = value === '$' && !quoted && nextSeg?.[0]?.word === 'mktemp'
  const wholeShape = quoted && value.startsWith('$(mktemp')
  if ((!cutShape && !wholeShape) || /TMPDIR/.test(cmd)) return false
  const mentions = cmd.match(new RegExp(`(?<![\\w$-])(?<!\\$\\{)${name}(?!\\w)`, 'g')) ?? []
  const assignments = cmd.match(new RegExp(`(?<![\\w$-])${name}=("?)\\$\\(mktemp${MKTEMP_FLAGS}[ \\t]*\\)\\1(?=$|[\\s;&|)])`, 'g')) ?? []
  return assignments.length > 0 && mentions.length === assignments.length
}

/** A write target `$D`, `${D}`, `$D/<name>` or `${D}/<name>` whose D holds MKTEMP at this segment, `<name>` holding
 *  no `..`, backslash, `$`, backtick, glob or whitespace — so it cannot leave the fresh directory, and an mktemp
 *  that failed (D empty) cannot turn `"$D"/*` into `/*`. */
function isMktempTarget(target: string, assigned: Map<string, string | typeof MKTEMP> | undefined): boolean {
  const m = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))(?:\/(.+))?$/.exec(target)
  if (m === null || assigned?.get(m[1] ?? m[2]) !== MKTEMP) return false
  return m[3] === undefined || !/\.\.|[\\$`*?[\]{}~\s]/.test(m[3])
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
// Attached spellings count too: `--method=DELETE`, `-XPOST` and `--field=k=v` are what pflag
// accepts, and an exact-word match released every one of them as a read.
const GH_API_WRITE = /^(?:-X|-f|-F)|^--(?:method|field|raw-field|input)(?:=|$)/
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
/** Resolves a word that is `$NAME`/`${NAME}`, optionally followed by `/suffix`, to a same-command
 *  literal assignment recorded STRICTLY BEFORE `segIdx` (shell semantics: `$S` expands before a
 *  same-segment prefix assignment applies — `S=/tmp/b tee "$S"` reads the OLD value of S, and an
 *  assignment only takes effect for LATER segments). Any other shape (`$(mktemp)`, `${NAME:-x}`,
 *  a name with no recorded literal) is returned unchanged and arms. */
type Resolve = (word: string, segIdx: number) => string
/** Whether a write target is exempt: `isEphemeralTarget` after `resolve`, or — for a declared-role worker only
 *  — `isRoleScratchTarget`. Built once per command in commandWriteReasons and threaded to every target check, so
 *  the redirect pass, the tee/rm/cp targets and the fastedit file-first target all judge alike (TRDD-QQ2XIIZ6). */
type Scratch = (target: string, segIdx: number) => boolean

// TRDD-J2K6IM4R: `fastedit multi-edit --help` armed the gate — argparse prints help and exits
// before ANY subcommand handler runs, so nothing is written, yet the classifier only looked at
// the write-verb SET and never at whether that verb's own argv asked for help. A STANDALONE
// -h/--help token (its preceding token not itself an option — an option's value could
// legitimately be the literal string "--help", e.g. `--snippet '--help'`, so that shape must
// still arm, conservatively) cancels ONLY the CLI-verb arm for that segment; a redirect/tee in
// the same segment still arms via the separate, unconditional redirect pass in
// `commandWriteReason`, and scanning stops at a bare `--` (end-of-options) because after it
// --help is positional DATA and the handler still runs. Exempt ONLY the two CLIs verified clean
// of any write-verb hyphen-swallowing positional or non-help -h remap (card evidence,
// 2026-09-23 second review): fastedit (argparse, src/fastedit/cli.py) and memgrep (clap,
// Cargo.toml). tldr has no write verb to exempt. trddgrep's hand-rolled parser (no
// argparse/clap) lets `--help` land as a literal field VALUE on `set <id> <field> --help` — a
// real write — so it is deliberately EXCLUDED from this rule, not merely unlisted.
function hasStandaloneHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return false
    if ((args[i] === '-h' || args[i] === '--help') && !(args[i - 1] ?? '').startsWith('-')) return true
  }
  return false
}

/** `via` names the launcher (`xargs`, `find -exec`) when the targets are not in this segment's text. */
function segmentWriteReason(base: string, args: string[], via: string | null, cwd: string, scratch: Scratch, segIdx: number): string | null {
  const flagless = args.filter((a) => !a.startsWith('-'))
  const deployOrDesign = deployOrDesignVerbWriteReason(base, args, scratch, segIdx)
  if (deployOrDesign !== null) return deployOrDesign
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
  // Any switch cluster that reaches `i`: `-lpi` / `-0777pi` / `-wpi` edit in place just like `-pi`.
  // `w` (warnings) is a no-argument cluster letter too, so `-wpi -e ...` was missed. Only the
  // no-argument cluster letters may precede it, so `-Ilib` / `-Mbigint` stay reads.
  if (base === 'perl' && args.some((a) => /^-[lnpaw0-9]*i/.test(a))) return 'perl -i'
  if (/^(npm|pnpm|yarn|bun|cargo|uv)$/.test(base)) {
    const sub = args[0] ?? ''
    if (PKG_WRITE.has(sub)) return `${base} ${sub}`
    return /^(install|i)$/.test(sub) && flagless.length > 1 ? `${base} install <pkg>` : null
  }
  if (base === 'agentlenspro' && !args.includes('--dry-run') && args.some((a) => a === 'setup' || /^--(un)?install-/.test(a))) return 'agentlenspro config write'
  if (base === 'memgrep' && /-mem-/.test(args[0] ?? '')) return hasStandaloneHelp(args) ? null : `memgrep ${args[0]}`
  // `find -exec <cmd>` runs <cmd> once per hit and `-delete` unlinks the hits: both are writes
  // the command word `find` hides (review 2026-09-08 — `find . -exec rm {} \;` released).
  // EVERY `-exec`, each through the wrapper walk: `-exec ls {} \; -exec rm {} \;` and
  // `-exec sudo rm` both released when only the first one's next word was classified.
  if (base === 'find') {
    if (args.includes('-delete')) return 'find -delete'
    for (let e = 0; e < args.length; e++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[e])) continue
      const r = classifyCommand(args.slice(e + 1).map((word) => ({ word, quoted: false })), 'find -exec', cwd, scratch, segIdx)
      if (r !== null) return r
    }
    return null
  }
  if (ALL_ARGS_ARE_TARGETS.includes(base) || LAST_ARG_IS_TARGET.includes(base)) {
    if (via !== null) return `${base} via ${via} (targets unknown)`
    const targets = ALL_ARGS_ARE_TARGETS.includes(base) ? flagless : flagless.slice(-1)
    // `scratch` resolves a same-command literal `$VAR` target to its recorded value before the
    // ephemeral check; the reported message still names the original text (`t`), not the value.
    const bad = targets.find((t) => !scratch(t, segIdx))
    return bad === undefined ? null : `${base} ${bad}`
  }
  return null
}

/** The command word of one segment (after wrappers, env assignments and a wrapper's own
 *  options), classified. A quoted word in command position is not a command. */
function classifyCommand(words: Word[], via: string | null, cwd: string, scratch: Scratch, segIdx: number): string | null {
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
  return segmentWriteReason(path.basename(words[i].word), words.slice(i + 1).map((w) => w.word), via, cwd, scratch, segIdx)
}

/** Why a shell command is a write, or null when its text shows only reads. Each segment's
 *  command word (after wrappers and env assignments) FIRST, then redirects anywhere (`>`, `>>`,
 *  `>|`, attached or spaced; `2>&1`/`>&2` are fd dups, not files) — in that order so a heredoc
 *  commit whose body holds a bare `>` is reported as the commit it is, not as a redirect. */
export function commandWriteReason(cmd: string, cwd: string): string | null {
  return commandWriteReasons(cmd, cwd)[0] ?? null
}

/** Every reason a shell command is a write, in the order the segment pass then the redirect pass
 *  finds them ([] when its text shows only reads). The worker path needs every segment's reason:
 *  a card record chained before a real write must not hide that write.
 *  `opts.roleScratch`: the caller verified the writer declared a ROLE (reviewGate's workerDeclaredRole), so an
 *  UNRESOLVABLE target inside an ephemeral directory is that role's scratch, not a write (isRoleScratchTarget). */
export function commandWriteReasons(cmd: string, cwd: string, opts: { roleScratch?: boolean } = {}): string[] {
  // shortcut: a bash -c / eval string contributes only its first reason, upgrade if workers start chaining inside one
  const reasons: string[] = []
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
  // entry rather than keeping the stale value, so it still fails closed. The one non-literal value
  // recorded is MKTEMP, for a `D=$(mktemp …)` (isMktempAssignment): it never resolves to a path, and
  // only a declared-role worker's `$D` / `$D/<name>` target may use it (isMktempTarget).
  const cumulative: Map<string, string | typeof MKTEMP>[] = [new Map()]
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k]
    const next = new Map(cumulative[cumulative.length - 1])
    if (seg.every((w) => ASSIGNMENT_RE.test(w.word))) {
      seg.forEach((w, j) => {
        const m = ASSIGNMENT_RE.exec(w.word) as RegExpExecArray
        if (!/[$`~*?{}[\]]/.test(m[2])) next.set(m[1], m[2])
        else if (isMktempAssignment(cmd, m[1], m[2], w.quoted, j === seg.length - 1 ? segments[k + 1] : undefined)) next.set(m[1], MKTEMP)
        else next.delete(m[1])
      })
    }
    cumulative.push(next)
  }
  // WHY: `$SP/file` (a scratchpad redirect) blocked a session three times on 2026-10-09, so the suffix
  // must resolve too; isEphemeralTarget still judges the joined path, so `$SP/../..` still arms.
  const resolve: Resolve = (word, segIdx) => {
    const m = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))(\/.*)?$/.exec(word)
    if (m === null) return word
    const value = cumulative[segIdx]?.get(m[1] ?? m[2])
    return typeof value === 'string' ? value + (m[3] ?? '') : word
  }

  // WHY (TRDD-QQ2XIIZ6, amendment A): every write target is judged here, after `resolve`. A declared-role worker
  // additionally passes an UNRESOLVABLE target whose static directory is ephemeral (isRoleScratchTarget) and, when
  // the tokenizer cut it at a `$(`, whose hidden substitution and tail hold no `/` or `..` (isFlatCutSubstitution),
  // and a `$D` / `$D/<name>` target whose D holds a same-command `$(mktemp …)` (isMktempTarget); a resolvable target
  // outside the ephemeral dirs still arms for every caller, role or not.
  const scratch: Scratch = (target, segIdx) => {
    const r = resolve(target, segIdx)
    if (isEphemeralTarget(r, cwd)) return true
    if (opts.roleScratch !== true) return false
    if (isMktempTarget(target, cumulative[segIdx])) return true
    return isRoleScratchTarget(r, cwd) && (!r.endsWith('$') || isFlatCutSubstitution(cmd, target))
  }
  for (let idx = 0; idx < segments.length; idx++) {
    const reason = classifyCommand(segments[idx], null, cwd, scratch, idx)
    if (reason !== null) reasons.push(reason)
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
    if (!scratch(target, segIdx)) reasons.push(`redirect into ${target || '(no target)'}`)
  }
  return reasons
}


// ── D7 (STAGE 1): additional write-shaped verbs + script-runner classification ─────────────────
// fastedit/trddgrep/prrdgrep/specgrep write verbs and the deploy commands this project actually
// runs were missing from commandWriteReason; folded here as its own predicate so
// `commandWriteReason`'s existing per-segment loop can call it alongside the existing verbs
// without widening `segmentWriteReason`'s own branch list.
const FASTEDIT_WRITE_VERBS = new Set([
  'edit', 'multi-edit', 'batch-edit', 'create', 'duplicate', 'split', 'join',
  'delete', 'move', 'rename', 'rename-all', 'move-to-file', 'undo',
])

// WHY: only these verbs write the file named by their first positional, so only they may exempt an
// ephemeral target. A duplicate/join/split source or a move/rename symbol in /tmp says nothing about the write.
const FASTEDIT_FILE_FIRST_VERBS = new Set(['create', 'edit', 'batch-edit', 'delete', 'undo'])
const TRDDGREP_WRITE_VERBS = new Set(['new', 'set', 'append', 'check-box', 'move', 'edit', 'fix'])

/** D7: fastedit / trddgrep / prrdgrep / specgrep write verbs, and the deploy commands
 *  (`node esbuild.js`, `pnpm|npm run package|compile|watch|local`, `agentlenspro server
 *  start|stop|restart`). */
function deployOrDesignVerbWriteReason(base: string, args: string[], scratch: Scratch, segIdx: number): string | null {
  if (base === 'fastedit') {
    const sub = args[0] ?? ''
    if (!FASTEDIT_WRITE_VERBS.has(sub)) return null
    if (hasStandaloneHelp(args)) return null
    // WHY: a file-first write into reports/, *_dev/ or /tmp is scratch, not work. Only the first positional
    // counts, and one after a flag arms (`--content-file /tmp/c src/new.ts`: /tmp/c is that flag's value).
    // The target is judged by `scratch` (TRDD-QQ2XIIZ6), like every redirect and tee target: a same-command literal
    // `$VAR` resolves first, and only a declared-role worker's unresolvable stamp may pass isRoleScratchTarget.
    const k = args.findIndex((a, n) => n > 0 && !a.startsWith('-'))
    if (FASTEDIT_FILE_FIRST_VERBS.has(sub) && k > 0 && !args[k - 1].startsWith('-') && scratch(args[k], segIdx)) return null
    return `fastedit ${sub}`
  }
  if (base === 'trddgrep') {
    let j = 0
    while (args[j] === '--design-dir') j += 2
    const sub = args[j] ?? ''
    if (sub === 'index-verify') return args.includes('--repair') ? 'trddgrep index-verify --repair' : null
    return TRDDGREP_WRITE_VERBS.has(sub) ? `trddgrep ${sub}` : null
  }
  if (base === 'prrdgrep' || base === 'specgrep') {
    let j = 0
    while (args[j] === '--design-dir') j += 2
    return (args[j] ?? '') === 'edit' ? `${base} edit` : null
  }
  if (base === 'node' && path.basename(args[0] ?? '') === 'esbuild.js') return 'node esbuild.js'
  if (/^(pnpm|npm)$/.test(base)) {
    let j = 0
    // (c): `--dir <path>` / `--prefix <path>` precede the verb (`pnpm --dir x run y`, `npm --prefix x run y`).
    if (args[j] === '--dir' || args[j] === '--prefix') j += 2
    if (args[j] !== 'run') return null
    const script = args[j + 1] ?? ''
    return /^(package|compile|watch|local)$/.test(script) ? `${base} run ${script}` : null
  }
  if (base === 'agentlenspro' && args[0] === 'server' && /^(start|stop|restart)$/.test(args[1] ?? '')) {
    return `agentlenspro server ${args[1]}`
  }
  return null
}

/** Script-file paths under an INSTALLED plugin's own cache/data dirs (e.g. the janitor's
 *  dispatcher stub) are exempt from the runner check — writing INTO those directories is itself
 *  gated, so running a file the plugin shipped there is not a fresh write surface. */
function isPluginCacheOrDataScript(word: string, cwd: string): boolean {
  if (word === '' || /[$`~*?{}[\]]/.test(word)) return false
  const abs = path.resolve(cwd, word)
  // A3: resolve symlinks and `..` before comparing — an escaping symlink or a `../` traversal
  // out of the plugin dirs must NOT be exempt. `realpathSync` throws on a nonexistent path,
  // which fails CLOSED (not exempt).
  let real: string
  try { real = fs.realpathSync(abs) } catch { return false }
  const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache')
  const data = path.join(os.homedir(), '.claude', 'plugins', 'data')
  const realCache = (() => { try { return fs.realpathSync(cache) } catch { return cache } })()
  const realData = (() => { try { return fs.realpathSync(data) } catch { return data } })()
  return [realCache, realData].some((d) => real === d || real.startsWith(d + path.sep))
}

const RUNNER_SINGLE_WORD = new Set(['deno', 'bun', 'ruby', 'php', 'make', 'tsx', 'ts-node', 'npx', 'uvx', 'node'])
const PY_RUNNER_RE = /^python[0-9.]*$/
const SHELL_RUNNER = new Set(['sh', 'bash', 'zsh'])
const PKG_RUNNER_BASE = new Set(['pnpm', 'npm', 'yarn'])
const PKG_RUNNER_VERBS = new Set(['run', 'exec', 'dlx'])
const INLINE_CODE_FLAG_RE = /^(-c|--command|-e|--eval)$/

/** D7 (script runners). Write-shaped like the verbs above — a runner can execute arbitrary
 *  written code — but roled forks MAY run them (measuring needs tests). Fails CLOSED on inline
 *  code (`-c`/`-e`/stdin/heredoc): a plugin-cache exemption is for a known SCRIPT FILE the
 *  plugin shipped, never for code text the caller supplies inline. */
export function scriptRunnerReason(cmd: string, cwd: string): string | null {
  const words = shellWords(stripHeredocBodies(cmd, true))
  let i = 0
  while (i < words.length && !words[i].quoted
    && (WRAPPERS.test(words[i].word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].word))) i++
  if (i >= words.length || words[i].quoted) return null
  const rawBase = words[i].word
  const base = path.basename(rawBase)
  const args = words.slice(i + 1)
  // Flagless candidates: a QUOTED word can still be a real script path (`uv run "/a b/x.py"`), so
  // quoting alone must not exclude it — only a literal `-` prefix does (checked on the unquoted
  // text, which is fine: a quoted argument's first character was never a real `-` flag anyway).
  const flaglessOf = (ws: typeof args): string[] => ws.filter((a) => !a.word.startsWith('-')).map((a) => a.word)
  const flagless = flaglessOf(args)
  const hasInline = args.some((a) => !a.quoted && INLINE_CODE_FLAG_RE.test(a.word))

  let isRunner = false
  let scriptArg: string | undefined
  if (PY_RUNNER_RE.test(base) || RUNNER_SINGLE_WORD.has(base)) { isRunner = true; scriptArg = flagless[0] }
  else if (base === 'uv' && args[0]?.word === 'run') { isRunner = true; scriptArg = flaglessOf(args.slice(1))[0] }
  else if (PKG_RUNNER_BASE.has(base) && PKG_RUNNER_VERBS.has(args[0]?.word ?? '')) { isRunner = true }
  else if (base === 'cargo' && /^(run|test|build)$/.test(args[0]?.word ?? '')) { isRunner = true }
  else if (base === 'go' && args[0]?.word === 'run') { isRunner = true; scriptArg = flaglessOf(args.slice(1))[0] }
  else if (SHELL_RUNNER.has(base) && flagless.length > 0) { isRunner = true; scriptArg = flagless[0] }
  else if (rawBase.startsWith('./') || path.isAbsolute(rawBase)) { isRunner = true; scriptArg = rawBase }

  if (!isRunner) return null
  if (hasInline) return `${base} (inline code)`
  if (scriptArg !== undefined && isPluginCacheOrDataScript(scriptArg, cwd)) return null
  return `${base} (script runner)`
}

/** A write target never gated, whatever tool asks for it: the existing ephemeral roots
 *  (`isEphemeralTarget`) plus `~/.claude/plans/` — MOVED here from `delegateGate.ts`
 *  (`isPlanningArtefact`, D3) so both the delegate gate and the review-loop gate share one
 *  definition; behaviour is unchanged. */
export function isNeverGatedTarget(file: string, cwd: string): boolean {
  if (isEphemeralTarget(file, cwd)) return true
  if (file === '' || /[$`~*?{}[\]]/.test(file)) return false
  const abs = path.resolve(cwd, file)
  const plansDir = path.join(os.homedir(), '.claude', 'plans')
  return abs === plansDir || abs.startsWith(plansDir + path.sep)
}


// ── Moved from the Stop/SubagentStop gate module (coordinator directive, stage 1) so the new
// pure review-loop module can import the sentinel without creating an import cycle once stage 2
// wires it in. The Stop/SubagentStop gate now imports these three names from here instead.

/** The sentinel an agent emits when it CANNOT spawn a reviewer — the only exit from either gate
 *  that does not require spawning one. ONE definition serves both gates deliberately: two copies
 *  would drift, and an agent that learned the phrase from one gate's message would be wedged by
 *  the other. Must be the FIRST thing in a text block (anchor rationale at each read site), and
 *  must carry a reason — so "I can't" is a statement someone can act on, not a magic word. The
 *  reason is never parsed; requiring it is what stops the phrase becoming a reflex. */
export const NO_REVIEW_SENTINEL = 'REVIEW-GATE: NO REVIEW POSSIBLE'

/** Canonical example reasons, shared between the block-message prose and the sentinel-floor test
 *  (`isNoReviewSentinel`) so the two can never drift apart — a message that offers an example the
 *  predicate itself would reject wedges the very agent it is telling how to exit. */
export const NO_REVIEW_SENTINEL_EXAMPLES = ['rate-limited', 'at a depth limit', 'tool denied'] as const

/** Does this text block open with the sentinel AND carry a reason? Written as a predicate rather
 *  than one regex because the regex form was WRONG in a way that read fine: with an optional
 *  separator class, `^\s*SENTINEL\s*[—:-]?\s*\S.{2,}` backtracks — it declines to consume the
 *  em-dash as the separator and counts it as the reason's first character instead, so a bare
 *  `SENTINEL — ab` satisfied the "≥3 characters of reason" rule with a dash and two letters.
 *  Caught by the test that asserts a reasonless sentinel does NOT release; a stricter-looking
 *  pattern that silently accepts the empty case is exactly the shape this gate cannot afford.
 *
 *  ANCHORED at the start of the trimmed block: a fork REVIEWING this gate quotes the sentinel in
 *  its findings, and a substring test would let that quotation release the agent under review.
 *  Nothing is stripped first, so `> SENTINEL` and `# SENTINEL` correctly fail — stripping the
 *  marker would be the very smuggling the anchor exists to stop. */
export function isNoReviewSentinel(text: string): boolean {
  const t = text.replace(/^\s+/, '')
  if (!t.startsWith(NO_REVIEW_SENTINEL)) return false
  const [firstLine, ...tail] = t.slice(NO_REVIEW_SENTINEL.length).split('\n')
  // NOTHING may follow the reason line: prose in a SEPARATE block re-arms the gate positionally
  // (its own index sets `lastWork`), but prose on a LATER LINE OF THE SAME block carries no index
  // of its own and cannot re-arm anything — constraining only `split('\n')[0]` therefore released
  // sentinel-then-entire-essay.
  if (tail.some((line) => line.trim() !== '')) return false
  // Any of — : - is accepted as the separator (an agent told to write an em-dash types a hyphen
  // often enough that keying the escape on punctuation would re-wedge an agent that obeyed in
  // substance). The reason itself must survive stripping them and be at least 8 characters — a
  // bound picked so every example NO_REVIEW_SENTINEL_EXAMPLES offers passes it, while a token
  // like "foo" does not.
  const reason = firstLine.replace(/^[\s—:-]+/, '').trim()
  return reason.length >= 8
}

// ── Record writes after a review (TRDD-9YWTNFU8) ─────────────────────────────────────────────────
// 17 of 38 audited review forks reviewed nothing but the note recording the previous review, in chains
// of 6 to 9. Writing down what a review found, on the card that review was about, is not new work, so
// it does not arm. This RELAXES coverage, so exactly two shapes qualify and any doubt returns null.

const SEGMENT_SEPARATOR_RE = /^(\||\|\||&&|;|&)$/
/** The folders a record write may touch: the TRDD lifecycle folders and the project memory. */
const CARD_DIRS = ['design/tasks/', 'design/proposals/', 'design/archived/', '.claude/project/memory/']
const isWord = (w: Word | undefined, s: string): boolean => w !== undefined && !w.quoted && w.word === s

/** A literal path a record write may touch: no shell metacharacter, no `..` segment, inside CARD_DIRS. */
function isCardPath(p: string, cwd: string): boolean {
  if (p === '' || /[$`~*?{}[\]]/.test(p) || p.split('/').includes('..')) return false
  const rel = path.relative(cwd, path.resolve(cwd, p))
  return CARD_DIRS.some((d) => rel.startsWith(d))
}

/** The paths of a git commit argument list, or null. Before --, the ONLY words accepted are -m <value>, -F <value>, -q and --quiet: an ALLOWLIST, because a denylist grows one flag at a time and every option it misses either widens the commit (-a, --fixup, --amend, --include) or skips the repo's hooks (--no-verify skips the pre-commit identity check). Paths must follow --, and each must be a card path. */
function commitPaths(args: string[], cwd: string): string[] | null {
  const dd = args.indexOf('--')
  if (dd < 0 || dd === args.length - 1) return null
  const flags = args.slice(0, dd)
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '-m' || flags[i] === '-F') {
      i++
      if (i >= flags.length) return null
    } else if (flags[i] !== '-q' && flags[i] !== '--quiet') return null
  }
  const paths = args.slice(dd + 1)
  return paths.every((p) => isCardPath(p, cwd)) ? paths : null
}

/** [NAME=value …] trddgrep [--design-dir <dir>]… append <card-id> …, as one segment; or null. Every --design-dir must name THIS project's design/ folder, because an append into another corpus is a write the gate would release unreviewed. A --design-dir after the id is refused whether quoted or not: the shell strips quotes before trddgrep reads its argv. */
function trddAppend(words: Word[], cwd: string): { kind: 'append'; id: string } | null {
  const ownDesign = path.resolve(cwd, 'design')
  let k = 0
  while (k < words.length && !words[k].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].word)) k++
  if (!isWord(words[k], 'trddgrep')) return null
  for (k++; isWord(words[k], '--design-dir'); k += 2) {
    const dir = words[k + 1]
    if (dir === undefined || path.resolve(cwd, dir.word) !== ownDesign) return null
  }
  if (!isWord(words[k], 'append')) return null
  const m = /^(?:TRDD-)?([A-Za-z0-9]{8})$/.exec(words[k + 1]?.word ?? '')
  if (m === null) return null
  if (words.slice(k + 2).some((w) => w.word === '--design-dir' || w.word.startsWith('--design-dir='))) return null
  return { kind: 'append', id: m[1].toUpperCase() }
}

/** The record a command makes, or null. Exactly two shapes qualify:
 *  (append) one `trddgrep append <card-id> …` segment;
 *  (commit) `git commit … -- <card paths>`, or `git add <card paths> && git commit … -- <the same paths>`.
 *  Anything else, or any doubt, returns null: the command arms the gate as it always did. */
export function recordWrite(cmd: string, cwd: string): { kind: 'append'; id: string } | { kind: 'commit' } | null {
  const words = shellWords(stripHeredocBodies(cmd, true))
  // A redirect writes wherever its target says, so an unquoted `<` or `>` is a doubt even when glued to a
  // word (`line>src/x` stays one word to shellWords). A `$` or backtick expands at run time, and
  // `"$(rm -rf src)"` stays one quoted word to shellWords, so either is a doubt too.
  if (words.some((w) => (!w.quoted && /[<>]/.test(w.word)) || /[$`]/.test(w.word))) return null
  const seps: number[] = []
  words.forEach((w, i) => { if (!w.quoted && SEGMENT_SEPARATOR_RE.test(w.word)) seps.push(i) })
  if (seps.length === 0) {
    const append = trddAppend(words, cwd)
    if (append !== null) return append
    const isCommit = isWord(words[0], 'git') && isWord(words[1], 'commit') && commitPaths(words.slice(2).map((w) => w.word), cwd) !== null
    return isCommit ? { kind: 'commit' } : null
  }
  // `git add <paths> && git commit …`: exactly one `&&`, and nothing else in the command.
  if (seps.length !== 1 || !isWord(words[seps[0]], '&&')) return null
  const before = words.slice(0, seps[0])
  const after = words.slice(seps[0] + 1)
  if (!isWord(before[0], 'git') || !isWord(before[1], 'add') || !isWord(after[0], 'git') || !isWord(after[1], 'commit')) return null
  const adds = before.slice(2).map((w) => w.word)
  const paths = commitPaths(after.slice(2).map((w) => w.word), cwd)
  // Each add must be a path the commit names: `git add x && git commit` would commit the whole index, so
  // files staged earlier would ride along, while `git commit -- <paths>` commits only those paths.
  return adds.length > 0 && paths !== null && adds.every((a) => paths.includes(a)) ? { kind: 'commit' } : null
}
