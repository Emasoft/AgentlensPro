#!/usr/bin/env node
// PreToolUse(Bash) guard: stop a command the FIRST time it names a path containing a symlink, hand
// the agent a one-time password, and let it proceed only by re-issuing the command with that OTP.
//
// NOT REGISTERED as of 89383dd4 — deny-pkgmanager-symlink-purge.js holds the user-scope slot, and
// running both double-prompts. The two do NOT subsume each other (see below), so the
// replace/alongside/merge call is the owner's.
//
// OWNER DIRECTIVE, 2026-09-03: "checking all paths (relative or absolute, simple or composite with
// env and var resolution) to verify if they are symlinks or not. and stop the command the first
// time if there are symlinks in it, warning the agent and giving it a one time password. if the
// agent want to proceed anyway, then it must retry the command adding the one time password."
// Scope confirmed when asked: "yes, all commands, all paths."
//
// WHY AN OTP RATHER THAN A DENY. A symlink in a path is not itself wrong — it is a fact the agent
// probably did not notice, and the damage comes from acting on it unaware. A hard deny would be
// wrong in both directions: it blocks legitimate work, and an agent that cannot proceed learns to
// route around the guard. An OTP stops the FIRST attempt, states what was found, and makes going
// ahead a deliberate, recorded act. This is the pattern `git_safety_guard.py` already uses on this
// machine, so it is one an agent here already knows how to satisfy.
//
// WHAT PROVOKED IT. On 2026-09-03 the main repo's node_modules was symlinked into a verification
// worktree; the next `pnpm run` tried to PURGE it through the link, at the real target, and aborted
// only because no TTY was attached. A narrower guard shipped first
// (deny-pkgmanager-symlink-purge.js) and covers exactly one command shape — a direct package-manager
// invocation. `make test`, `./ci.sh` and `node build.js` walk straight past it. This one is keyed on
// the PATH, not the command, so the command shape stops mattering.
//
// THE FRICTION, AND WHY IT IS BOUNDED. Measured before building: on macOS `/tmp`, `/var` and `/etc`
// are themselves symlinks (`/tmp -> private/tmp`) and every Homebrew formula links through
// `opt/<pkg> -> ../Cellar/...`. Stopping on those would have meant an OTP for a large share of
// ordinary commands, so they are excluded by SAFE_ROOTS below (owner: "exclude known things like
// homebrew or others known symlinks"). What remains is symlinks the AGENT or the USER created —
// which is the population the guard is actually about.
//
// WHAT THIS DOES NOT COVER. It inspects paths NAMED IN THE COMMAND. `make test`, `./ci.sh` and
// `node build.js` name no path, so a package manager reached through one of them is invisible here
// exactly as it is to the narrower guard. That gap needs a check at CHECKOUT-CREATION time and is
// TRDD-SVCUAPES, not this file. Do not read this guard as closing it.
//
// AND IT DOES NOT SUBSUME THE PNPM GUARD, despite covering more commands. That one fires on
// `pnpm install` in a directory whose node_modules escapes — where NO path appears in the command
// text at all, so there is nothing here to extract. This one fires on `rm -rf /tmp/wt/node_modules`
// — a named path, no package manager. Neither contains the other. Replacing one with the other
// loses real coverage; the honest end state is ONE file with both checks, which is a card, not a
// silent deletion.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// Paths whose symlink-ness is a PLATFORM FACT, not a signal about this command (owner: "exclude
// known things like homebrew or others known symlinks"). Every entry was measured on this machine
// 2026-09-03, not assumed:
//
//     /tmp  -> private/tmp     /var -> private/var     /etc -> private/etc     (macOS, always)
//     /opt/homebrew/opt/<pkg> -> ../Cellar/<pkg>/<version>                     (every formula)
//
// `/opt/homebrew` and `/opt/homebrew/bin` are themselves REAL directories — the links are the
// per-formula `opt/<pkg>` entries and the bin shims that point into Cellar. So the exclusion is
// scoped to those subtrees rather than to homebrew wholesale.
//
// The bar for adding here is a symlink that is a property of how the OS or a package manager lays
// itself out, identical on every machine of this kind, and never a thing the agent chose. A path
// the AGENT created — a worktree, a scratch dir, a vendored copy — is never in this list, because
// that is exactly the case the guard exists for. An allowlist grown on a hunch is how a guard
// quietly stops guarding, so each line above carries what it is and why it cannot be a signal.
// TWO CLASSES, and conflating them silently disables the guard where it matters most.
//
// SAFE_EXACT — the directory ITSELF is the platform symlink. Excluded as an exact path ONLY.
// Everything BENEATH it is still inspected, because `/tmp` being a link says nothing about
// `/tmp/my-worktree/node_modules`. Measured 2026-09-03: a first draft listed these as PREFIXES,
// which excluded the whole of `/tmp` and `/var/folders/...` — i.e. every scratch dir, every
// worktree, and the exact location (`/tmp/verify-09acee40`) of the incident that motivated this
// guard. The matrix caught it because its own fixture lives in a temp dir and every real case
// silently passed.
const SAFE_EXACT = new Set([
  '/tmp', '/var', '/etc', '/private/tmp', '/private/var', '/private/etc',
])

// SAFE_PREFIX — the links live INSIDE these trees and are created by a package manager, never by
// the agent: `/opt/homebrew/opt/<pkg> -> ../Cellar/<pkg>/<version>`, and the bin shims.
const SAFE_PREFIX = [
  '/opt/homebrew/opt', '/opt/homebrew/Cellar', '/opt/homebrew/bin',
  '/usr/local/opt', '/usr/local/Cellar', '/usr/local/bin', // intel-mac prefix
]

// READ-ONLY COMMANDS never need the OTP: following a symlink to LOOK at something destroys nothing,
// and these are the bulk of what an agent runs. Owner: "you must also exclude readonly commands like
// ls, cat, find, etc."
//
// The exemption is ARG-AWARE, because read-only-ness is a property of the invocation, not the name:
//   - `cat x > y` and `ls > out` WRITE through a redirect;
//   - `find . -delete`, `-exec`, `-execdir`, `-fprint`, `-fls` mutate or write;
//   - `sed -i`, `sort -o`, `tee`, `rsync` are not on the list at all.
// A name-only exemption would be a hole an agent walks through by accident, so any redirect or any
// mutating flag drops the segment back into the checked path.
const READONLY = new Set([
  'ls', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'wc', 'du', 'df',
  'find', 'grep', 'rg', 'ag', 'ack', 'fd', 'diff', 'cmp', 'md5', 'shasum', 'sha256sum',
  'realpath', 'readlink', 'dirname', 'basename', 'pwd', 'echo', 'printf', 'which', 'type',
  'tree', 'jq', 'yq', 'cut', 'sort', 'uniq', 'nl', 'strings', 'xxd', 'od',
  // NOT here, deliberately: sed/perl/python/ruby/node/tee/rsync/tar/install/truncate write by
  // design. `awk` was in this set and was REMOVED — it looks like a text filter but is a
  // general-purpose language with `system()` and `print > file`, so `awk '{system("rm " $0)}' path`
  // is a write with no redirect character anywhere for the redirect check to catch.
])
// PER-COMMAND, because the same letter means opposite things. `-i` is IN-PLACE for sed and perl but
// IGNORE-CASE for grep and diff; `-o` writes a file for sort but means only-matching for grep.
// A global flag list denied `grep -i foo <path>` and `diff -i a b` — measured 2026-09-03, and those
// are among the most common commands an agent runs, so the exemption would have been worthless.
// LONG FORMS TOO. `-o` alone missed `sort --output=<path>`, which writes — a mutating invocation
// classified read-only, i.e. a bypass, found by a security review 2026-09-03. Any short flag with a
// GNU long equivalent needs both spellings, and `=` must be accepted as the value separator.
const MUTATING_FLAGS = {
  find: /(?:^|\s)-(?:delete|exec|execdir|fprint|fls|fprintf|ok|okdir)\b/,
  sort: /(?:^|\s)(?:-o\b|--output(?:=|\b))/,
  jq:   /(?:^|\s)(?:-i\b|--in-place\b)/,
  yq:   /(?:^|\s)(?:-i\b|--inplace\b)/,
}

/** Redirects that WRITE. `2>&1` merges stderr into stdout and creates nothing; a `>` inside a
 *  quoted argument (`grep "a > b" f`) is data, not syntax — both were denied before quotes were
 *  stripped and the fd-dup form excluded. */
function hasWritingRedirect(segment) {
  const unquoted = segment.replace(/'[^']*'|"[^"]*"/g, ' ')
  return /(?:^|\s)\d?>>?(?!&\d)/.test(unquoted)
}

/** True when this segment only READS. Read-only-ness is a property of the INVOCATION, not the name:
 *  a writing redirect or a command-specific mutating flag disqualifies it. */
function isReadOnlySegment(segment, word) {
  if (!READONLY.has(word)) return false
  if (hasWritingRedirect(segment)) return false
  const flags = MUTATING_FLAGS[word]
  return !(flags && flags.test(segment))
}

const isExcluded = (p) => SAFE_EXACT.has(p) || SAFE_PREFIX.some((r) => p === r || p.startsWith(r + path.sep))

const OTP_DIR = path.join(os.tmpdir(), 'agentlens-symlink-otp')
const OTP_TTL_MS = 15 * 60 * 1000

/** Expand ~ and $VAR / ${VAR} from the hook's environment. A token that still contains an
 *  unresolved `$` after this is dropped: guessing at a variable we cannot see would produce a
 *  verdict about a path that does not exist. */
function expand(tok) {
  let s = tok
  if (s.startsWith('~/') || s === '~') s = path.join(os.homedir(), s.slice(1))
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => process.env[a || b] ?? m)
  return s.includes('$') ? null : s
}

/** Every token in the command that could name a path. Deliberately generous — a token that is not a
 *  path simply will not exist on disk and is skipped by the caller. Quotes are stripped so
 *  `"/a/b"` is inspected; a token with no `/` at all is not a path worth walking. */
function pathTokens(cmd, baseDir, baseIsExplicit) {
  const out = []
  const seen = new Set()
  const add = (tok) => {
    if (!tok || tok.startsWith('-') || seen.has(tok)) return
    seen.add(tok)
    if (!tok.includes('/') && !tok.startsWith('~') && !tok.startsWith('$')) return
    const e = expand(tok)
    if (!e || !e.includes('/')) return
    // A RELATIVE token that does not exist is not a path this command means. Walking up from it
    // reaches the ancestors of the HOOK's cwd, so `grep "src/foo bar" <path>` would report a
    // symlink the command never referenced — and on a machine whose project sits under a symlinked
    // path (`~/Code -> /Volumes/dev/Code`) that fires on every quoted slash-containing string.
    // Absolute and ~/$-rooted tokens are still checked whether they exist or not: a symlinked
    // ANCESTOR of a not-yet-created file is exactly the case worth catching.
    // Resolve against the EFFECTIVE cwd (after any `cd` in this pipeline), not the hook's.
    const abs = path.isAbsolute(e) ? e : path.resolve(baseDir, e)
    // The existence gate applies ONLY when no `cd` established the base. Without one, a relative
    // token resolves against the session cwd and walking up reaches ITS ancestors — reporting a
    // symlink the command never referenced (the machine-dependent cliff on a project under a
    // symlinked path). After an explicit `cd`, the base is intentional and the path is meaningful
    // whether or not its leaf exists yet: `cd <wt> && cp x ./node_modules/f` must be caught on the
    // symlinked ANCESTOR, and requiring `f` to exist misses exactly that.
    if (!path.isAbsolute(e) && !baseIsExplicit && !fs.existsSync(abs)) return
    out.push({ raw: tok, resolved: abs })
  }

  // QUOTED SEGMENTS FIRST, whole. Splitting on whitespace destroys `"/Users/me/My Project/x"` into
  // two tokens, neither of which exists, so a symlinked path is silently ALLOWED — measured
  // 2026-09-03 for all three spellings (double-quoted, single-quoted, backslash-escaped). Paths with
  // spaces are routine on macOS (iCloud Drive, anything named in a GUI), so this was not an edge
  // case; it was a hole under the most ordinary directory names a person has.
  const rest = cmd.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g, (_m, _q, inner) => {
    add(inner)
    return ' '
  })

  // Then unquoted tokens, joining backslash-escaped spaces (`My\ Project`) before splitting.
  for (const raw of rest.replace(/\\ /g, '\u0000').split(/[\s;|&<>()]+/)) {
    add(raw.replace(/\u0000/g, ' '))
  }
  return out
}

/** The command's effective working directory: a `cd`/`pushd` in the same pipeline wins over the
 *  session cwd. LIFTED VERBATIM from deny-pkgmanager-symlink-purge.js, where it is
 *  mutation-verified — this guard shipped without it, so `cd <worktree> && cp x node_modules/`
 *  resolved the relative path against the HOOK's cwd, found nothing, and allowed. That is the
 *  original incident's exact shape, uncaught, in the guard built to generalise it.
 *
 *  Returns `{dir, matched}`. `matched` is load-bearing and the caller must not re-derive it as
 *  `dir !== sessionCwd`: `cd .` and `cd $PWD` are explicit cds that leave the dir identical, and
 *  the caller uses "an explicit cd set this base" to decide whether a NON-EXISTENT relative path
 *  is still worth resolving. Inferring it from the dir answers that question wrong in exactly the
 *  case where a worktree and the hook cwd happen to coincide. */
function effectiveCwd(segment, baseCwd) {
  // `(` is a boundary, not text: `(cd <wt> && cp x node_modules/)` is the incident shape wearing
  // parentheses, and a `\s`-only boundary rejected the cd, resolved the relative path against the
  // HOOK's cwd, found nothing, and ALLOWED. Measured 2026-09-04 — the brace form `{ cd … ; }` was
  // caught the whole time only because `{` happens to be followed by a space.
  //
  // A cd inside a command substitution runs in a subshell and never moves the parent, so blank
  // those spans before looking. The first attempt was a `(?<!\$)\(` lookbehind on the boundary,
  // which is a character-level guard on a REGION-level problem: `$( cd x && …)`, with one space,
  // matched the `\s` branch instead and the lookbehind was never consulted. Measured 2026-09-04 —
  // prefixing `echo $( cd /elsewhere && pwd ) &&` turned a DENY into an ALLOW. Blanking the region
  // needs no boundary trickery and covers every spelling of the inside. Length does not matter
  // here: this function extracts a target, it computes no offsets.
  //
  // NOTE this reads the CONTENT slice, so it treats a QUOTED `$(` as an opener where the depth
  // counter (reading the masked syntax view) does not. The two deliberately disagree; what makes
  // that unreachable is segmentation — a `cd` always starts its own stage, so a quoted `$(` and an
  // applying `cd` can never share one. Loosen the split and this becomes live.
  // The second replace is the load-bearing one: segmentation splits on `&&`/`;`/`|`, which are
  // ordinary characters INSIDE a substitution, so `echo $( cd x && pwd ) && cp …` reaches this
  // function already torn into `echo $( cd x ` — an unbalanced `$(` whose cd looks top-level. Blank
  // from an unclosed opener to the end of the segment; a plain `(cd wt && …)` subshell has no `$`
  // and stays visible, which is the shape the `(` boundary above exists for.
  const visible = segment
    .replace(/\$\([^()]*\)|`[^`]*`/g, (s) => ' '.repeat(s.length))
    .replace(/\$\([\s\S]*$|`[\s\S]*$/, (s) => ' '.repeat(s.length))
  // `)` is excluded from the target for the same reason `&;|` are: it is shell syntax, and a
  // segmentation split can leave it trailing. `cd /tmp/other )` took the `)` as part of the name,
  // giving the fictional base `/tmp/other )` — the invented-directory bypass, arriving by a route
  // the glob and `$var` bailouts do not cover. Measured 2026-09-04.
  // ...but ONLY in the unquoted branch, which is why the alternation is spelled out instead of one
  // class with an optional quote around it. `)` is syntax OUTSIDE quotes and content INSIDE them:
  // excluding it everywhere meant `cd 'My Docs (2026)'` matched nothing at all — the closing quote
  // could no longer be reached — so no cd was seen and the base never moved. Measured 2026-09-04,
  // and parenthesised directory names are routine (`Screenshot (1)`, `Backup (old)`). Same shape as
  // the `[`/`]` regression one commit earlier: a character that is syntax in one view and a name in
  // the other, judged by a single predicate.
  // `)` must also TERMINATE the match, not merely be excluded from the name. Excluding it without
  // accepting it as a boundary left `(cd /tmp/wt)` — no space — matching NOTHING at all: the class
  // stops at `)`, the trailing `(?:\s|$)` cannot match there, and every backtrack fails the same
  // way. Measured 2026-09-04. Pre-existing, but it is the mirror of the bug one commit earlier:
  // there `)` was unreachable for a QUOTED target, here it is unreachable as a TERMINATOR for an
  // unquoted one. Both come from treating `)` as a character to exclude rather than a boundary.
  const m = /(?:^|[\s(])(?:cd|pushd)\s+(?:--\s+)?(?:'([^']+)'|"([^"]+)"|([^'"&;|)]+))(?:\s|\)|$)/.exec(visible)
  if (!m) return { dir: baseCwd, matched: false }
  const target = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  if (!target || target === '-') return { dir: baseCwd, matched: false }
  // A `$var` this guard cannot expand must NOT move the base. `cd $PWD && cp x node_modules/`
  // resolved to `<cwd>/$PWD/node_modules` — a directory that does not exist — and `matched: true`
  // then waved the relative path past the existence gate, so the REAL `<cwd>/node_modules` symlink
  // was never looked at. Measured 2026-09-04: adding a no-op `cd $PWD &&` turned a DENY into an
  // ALLOW. A guard defeated by a no-op prefix is not a guard, so an unresolvable target leaves the
  // base exactly where it was and claims nothing. PWD and HOME are expanded because they are the
  // two we can know; anything else stays put.
  // ONE expansion, applied to every spelling of the target. It used to be inline here, so the
  // whole-word repair below resolved a RAW string while this path resolved an EXPANDED one, and
  // neither carried both fixes: `cd $PWD/a(b)` truncated to `<cwd>/a(b` on one side and stayed
  // `$PWD/a(b)` on the other, so the correct `<cwd>/a(b)` was never constructed and the symlink was
  // never examined. Measured 2026-09-04 — an ALLOW built from two half-right strings.
  const expand = (s) => s
    .replace(/^\$\{?PWD\}?(?=\/|$)/, baseCwd)
    .replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, process.env.HOME || '')
  const expanded = expand(target)
  // Same rule for a leftover `~`: `~otheruser` is a home this guard cannot resolve, and resolving
  // it against baseCwd would invent `<cwd>/~otheruser` — the same fictional-directory bypass.
  if (/[$`]/.test(expanded) || expanded.startsWith('~')) return { dir: baseCwd, matched: false }
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded)
  // A glob is a directory only the shell knows, so `cd *` must not invent `<cwd>/*` as a base. But
  // glob characters are also ordinary characters in a real directory name — `My Docs [2026]` is
  // routine on macOS — and a blanket character test stopped tracking those. Measured 2026-09-04:
  // that regressed `cd 'My Docs [2026]' && cp x node_modules/` from DENY to ALLOW, to buy a `cd *`
  // improvement the tests showed was worth nothing. Ask the filesystem instead of guessing: if the
  // literal name exists, it is a directory, not a pattern.
  const isDirectory = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
  if (/[*?[\]]/.test(expanded) && !isDirectory(resolved)) return { dir: baseCwd, matched: false }
  // A `)` TERMINATOR can cut a real name short: `cd /tmp/a(b)/sub` stops the unquoted branch at the
  // `(`-less `)`, yielding `/tmp/a(b` — a directory that does not exist — and `matched: true` then
  // disables the existence gate, which is the `cd $PWD` bug arriving by a new route. Measured
  // 2026-09-04. Note the harm is not the truncation itself (the old regex matched nothing here,
  // also a miss) but the flip from the conservative `matched: false` to an active gate-disable.
  // So when a `)` ended the match, put the `)` back if THAT is the real directory, and claim
  // nothing when neither spelling exists. It CAN turn `matched` false into true — that is the first
  // line's whole job — but it can never return `matched: true` on a base that does not exist, which
  // is the property the bailouts above are actually protecting.
  // Reattaching a single `)` is not enough — the truncation loses everything after it too
  // (`/tmp/a(b)/sub` stops at `/tmp/a(b`), so take the WHOLE unquoted word from the original text,
  // up to the next real separator, and prefer it when it is a real directory.
  if (m[0].endsWith(')') && m[3] !== undefined) {
    const start = m.index + m[0].lastIndexOf(m[3])
    let end = start
    while (end < visible.length && !/[\s&;|'"]/.test(visible[end])) end += 1
    // `whole` comes from `visible`, where a `$( … )` is blanked to spaces — so a substitution
    // abutting the name reads as a separator and ends the word early. Gated by isDirectory below.
    const whole = expand(visible.slice(start, end))
    const wholeResolved = path.isAbsolute(whole) ? whole : path.resolve(baseCwd, whole)
    if (whole !== expanded && isDirectory(wholeResolved)) return { dir: wholeResolved, matched: true }
    if (!isDirectory(resolved)) return { dir: baseCwd, matched: false }
  }
  return { dir: resolved, matched: true }
}

/** The first symlink at or above `p`, or null. Walks ancestors because `/tmp/x/y` is a symlinked
 *  path when `/tmp` is the link — which is the macOS case and the whole reason ancestors matter. */
function firstSymlink(p) {
  let cur = path.resolve(p)
  const seen = new Set()
  for (;;) {
    if (seen.has(cur)) return null // defensive: never loop
    seen.add(cur)
    if (!isExcluded(cur)) {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) {
          let target = '<unresolvable>'
          try { target = fs.realpathSync(cur) } catch { /* broken link: still a symlink */ }
          return { link: cur, target }
        }
      } catch { /* does not exist: not a symlink, keep walking up */ }
    }
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

function otpPath(token) { return path.join(OTP_DIR, token + '.json') }

/** Drop tokens past their TTL. Without this the store grows without bound — a token is now consumed
 *  only on a SUCCESSFUL match, so every abandoned or mistyped retry leaves a file behind forever.
 *  Measured 2026-09-03: 110 files had accumulated from test runs alone. Expiry is already enforced
 *  at verify time, so this reclaims space rather than adding a security property. */
function purgeExpired() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(OTP_DIR)) {
      const full = path.join(OTP_DIR, f)
      try {
        if (now - fs.statSync(full).mtimeMs > OTP_TTL_MS) fs.unlinkSync(full)
      } catch { /* raced with another hook run: it is gone either way */ }
    }
  } catch { /* unreadable store: never let housekeeping break the guard */ }
}

/** Issue a single-use, time-limited password bound to THIS command text. Binding matters: an OTP
 *  that authorises any command would let one approval carry a different, unreviewed action. */
function issueOtp(cmd) {
  const token = crypto.randomBytes(4).toString('hex').toUpperCase()
  try {
    // 0o700: the token IS the filename, so mode on the FILE protects nothing — anyone able to LIST
    // this directory reads the secret. mkdirSync's `mode` is ignored when the directory already
    // exists, so a dir created by an earlier version keeps its 0o755 forever; measured 2026-09-03,
    // the option was passed and the mode was still 755. chmod unconditionally instead of trusting
    // the create.
    fs.mkdirSync(OTP_DIR, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(OTP_DIR, 0o700) } catch { /* not ours to chmod: the token still expires */ }
    purgeExpired()
    fs.writeFileSync(otpPath(token), JSON.stringify({ cmd, at: Date.now() }), { mode: 0o600 })
  } catch { /* cannot persist: the OTP simply will not verify, and the guard stays closed-but-passable */ }
  return token
}

/** True when the command carries a VALID, unexpired OTP for its own text (minus the OTP itself).
 *  Consumes it: a password that works twice is not a one-time password. */
function consumeOtp(cmd) {
  const m = /(?:^|\s)SYMLINK_OTP=([0-9A-F]{8})(?=\s|$)/.exec(cmd)
  if (!m) return false
  const bare = cmd.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
  const file = otpPath(m[1])
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    const sameCmd = String(rec.cmd ?? '').replace(/\s+/g, ' ').trim() === bare
    const fresh = Date.now() - Number(rec.at ?? 0) < OTP_TTL_MS
    // Consume ONLY on success. Burning the token on a failed attempt destroys one the agent could
    // still have used correctly — the common failure is a retry whose command text changed, not an
    // attacker. Guessing is already impractical: 4 billion tokens, a 15-minute TTL, and every guess
    // costs a full hook round-trip.
    if (sameCmd && fresh) { fs.unlinkSync(file); return true }
    return false
  } catch {
    return false
  }
}

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let cmd = ''
  // The session's cwd, which relative paths resolve against. Lazy and guarded: `process.cwd()`
  // THROWS when the session's directory has been deleted — the post-worktree-removal state this
  // guard exists for.
  let sessionCwd = ''
  const safeCwd = () => { try { return process.cwd() } catch { return '/' } }
  try {
    const payload = JSON.parse(raw)
    cmd = String(payload?.tool_input?.command ?? '')
    sessionCwd = (typeof payload?.cwd === 'string' && payload.cwd) ? payload.cwd : safeCwd()
  } catch {
    process.exit(0) // unreadable payload: a guard that blocks every call because it cannot read its
                    // own input is worse than the thing it guards against
  }
  if (!cmd) process.exit(0)

  let hit = null
  let maskBroken = null
  // FAIL OPEN on any internal error. A PreToolUse hook that throws stops guarding while the session
  // looks normal, so every failure path here allows and says so on stderr.
  try {
    if (consumeOtp(cmd)) process.exit(0)
    // PER SEGMENT, because read-only-ness is not a property of the whole command line:
    // `ls /tmp/link && cp x /tmp/link/y` is half read-only, and exempting the line would exempt the
    // half that writes. Splitting on the same separators the shell uses keeps each verb judged on
    // its own arguments.
    // `2>&1` must be neutralised BEFORE segmenting: `&` is a separator, so the split tears it into
    // `2>` and `1`, and the orphaned `2>` then reads as a bare writing redirect. Measured
    // 2026-09-03 — `ls <symlink> 2>&1` was denied, which is a pure stderr merge that creates
    // nothing.
    // Mask QUOTED spans before any splitting: a `|` inside `grep "a|b" path` is data, and splitting
    // on it invented a stage whose command word was `b"` — unknown, so the whole pipeline re-armed
    // and a plain grep was denied. Masking preserves length so the extracted path tokens still line
    // up with the original text.
    const masked = cmd.replace(/'[^']*'|"[^"]*"/g, (m) => ' '.repeat(m.length))
    // LENGTH-PRESERVING, like the quote mask above. Collapsing `2>&1` to a single space shifted
    // every offset after it, so the stage sliced from the original text was misaligned and its
    // paths were never extracted — measured 2026-09-03: `cp a b 2>&1 ; cp x <symlink>` was ALLOWED.
    // That is a MISS, not friction: any command with a redirect before the dangerous one went
    // unchecked. Every mask in this path must keep the string the same length as `cmd`.
    const segmentable = masked.replace(/\d?>&\d?/g, (m) => ' '.repeat(m.length))
    // ...and this is what keeps that sentence true rather than merely asserted in a comment. Stage
    // offsets are computed on `segmentable` and used to slice `cmd`, so a mask that ever changed
    // length would extract a DIFFERENT path than the one the command names — a wrong answer with
    // full confidence, the worst shape a guard has. Unlike the catch below this does NOT fail open:
    // it stops analysing and reports what it cannot check, because "I could not read this command"
    // is a true statement and "no symlink here" would not be. It only RAISES the flag here and
    // writes its verdict outside the try — writing it in place put the one branch designed to fail
    // CLOSED inside the catch that fails OPEN, so an EPIPE on its own stdout would have reverted it.
    if (segmentable.length !== cmd.length) {
      maskBroken = `${cmd.length} -> ${segmentable.length}`
      throw new Error('mask length invariant broken')
    }
    // PIPELINES FIRST. A read-only command is only harmless if its OUTPUT goes nowhere dangerous:
    // `ls /tmp/link | oppa` reads through the symlink and hands the result to a binary we know
    // nothing about (owner, 2026-09-03: "you don't know what oppa does, but since ls pipes its
    // output into oppa, you must trigger the protection"). Judging stages independently made this
    // ALLOW — `ls` was exempt and `oppa` named no path. So a stage keeps its exemption only when
    // EVERY stage of its pipeline is itself known-read-only: `ls x | grep y` stays quiet, and one
    // unknown command anywhere in the chain re-arms the whole pipeline.
    // `dir` lives ACROSS pipelines: `cd <wt> && cp x node_modules/` splits into TWO, so a `dir`
    // scoped inside the loop resets before the command that matters and the cd is lost.
    //
    // But it carries ONLY across separators meaning "the cd ran and we are still in that shell":
    // `;`, `&&`, newline. `||` runs its right side only when the left FAILED, and a bare `&`
    // backgrounds the cd in a subshell — in both cases the following command runs in the ORIGINAL
    // directory. An earlier version carried across everything, justified as "over-resolving can
    // only produce an extra prompt, never a missed symlink". That was wrong: measured 2026-09-03,
    // `cd <wt> || cp x node_modules/` DENIED while naming `<wt>/node_modules`, a path that command
    // cannot touch. A verdict about the wrong file is not friction, it is incorrect.
    //
    // Nor does it carry across a bare `|`: every stage of a pipeline runs in its OWN subshell, so
    // `cd <wt> | cp x node_modules/` leaves the `cp` in the ORIGINAL directory, and a cd anywhere
    // inside a multi-stage pipeline never reaches the commands AFTER the pipeline either. Measured
    // 2026-09-03: carrying it made that DENY while naming `<wt>/node_modules`, a path the command
    // cannot reach — the same wrong-file verdict as the `||` case above, one separator over.
    let dir = sessionCwd
    let dirExplicit = false
    // A second base to check when the depth is a guess — see the `bases` comment below.
    let altDir = null
    const parts = segmentable.split(/(\|\||&&|[;&\n])/)
    // A capturing split keeps every piece in order, so a part's offset is the running sum of the
    // ones before it — exact, and it must advance past the separators too. The earlier
    // `indexOf(pipeline)` returned the FIRST match, so two parts with equal masked text sliced
    // their content from the same place; that was harmless only because the mask is
    // length-preserving and covers no path characters, which is an invariant elsewhere in this
    // file, not a property of the slicing.
    let cursor = 0
    // Substitution depth, counted ACROSS parts. Blanking `$( … )` inside one part cannot see an
    // opener two parts away, and nesting puts one there: in
    // `echo $( echo $(date) && cd /elsewhere ) && cp x <link>/` the inner `)` balances part 1, so
    // the `cd` lands in a part with no opener in it and reads as top-level. Measured 2026-09-04 —
    // that prefix hid a real symlink. Counting bare `)` also closes a plain `(subshell)`, which is
    // safe in one direction only: it can make depth SMALLER, i.e. more cds visible, never fewer.
    let subDepth = 0
    // Count on the MASKED view, and count LEFTOVERS rather than parity. A successful mask blanks
    // every quoted span, so a quote still present in `segmentable` IS the evidence the mask failed
    // — a detection, not a proxy. Parity on the RAW command was a proxy, and a wrong one in both
    // directions: `echo "it's fine"` masks perfectly yet has an odd `'` count, so ANY apostrophe or
    // nested quote — `git commit -m "don't"` — disabled the depth gate for the whole command line
    // and re-opened the nesting bypass 880b5deb closed. Measured 2026-09-04.
    //
    // This is 1c337d57's lesson one layer over: that commit moved the depth count off the raw
    // string, and this check was then added on the raw string. Same mistake, same fix.
    const quotesUnbalanced = /['"]/.test(segmentable)
    for (const part of parts) {
      const base = cursor
      cursor += part.length
      // Count on the MASKED text. Stage CONTENT is sliced from `cmd` on purpose — a quoted path
      // must stay extractable — but depth wants SYNTAX, and `grep '$(' f` is an argument, not an
      // opener. Reading `cmd` here counted it, left subDepth stuck at 1, and every later part was
      // treated as inside a subshell: measured 2026-09-04, prefixing `grep '$(' f &&` skipped a
      // real cd and turned a DENY into an ALLOW. `segmentable` is length-preserving (asserted
      // above), so the same offsets index it.
      //
      // Known and deliberately unfixed: `$((` counts one open and two closes, a net -1 the clamp
      // absorbs. Masking does not help — arithmetic is not quoted. No reachable exploit was found,
      // because over-closing only makes MORE cds visible; but that safety is the clamp's doing, so
      // do not remove the clamp without revisiting this.
      const partSyntax = segmentable.slice(base, base + part.length)
      // The quote mask needs a CLOSING quote, so an unbalanced one masks nothing and leaves a
      // quoted `$(` visible in the syntax view — subDepth then sticks open and every later cd is
      // skipped. Measured 2026-09-04: `echo "$( && cd <wt> && cp x node_modules/` ALLOWED. A mask
      // that cannot report its own failure is the recurring hazard here (the length assertion
      // above is the same idea); when it failed, stop trusting the depth and let every cd through.
      // That is the over-resolving direction — it costs an OTP prompt, never a miss.
      const insideSubst = subDepth > 0
      subDepth = Math.max(0, subDepth
        + (partSyntax.match(/\$\(/g) || []).length
        - (partSyntax.match(/\)/g) || []).length)
      // The count is per-part NET and clamped at 0, so ANY part whose `)` count reaches its `$(`
      // count reads as balanced — `) … $(` is only the shortest spelling; a stray `)` from a `case`
      // arm does it too. The clear below then fires while the shell is inside a NEW substitution.
      // That is the under-tracking direction, and no reachable shape was found (the per-part
      // blanking covers the ones that get there) — but it is the seam to check first if a nesting
      // bypass ever comes back. The clamp, not the spelling, is what makes it possible.
      //
      // The alternate base exists only while the base is IN DOUBT. Once the substitution closes the
      // doubt is over, and keeping it would deny on a path the command cannot reach — the
      // wrong-file verdict this file has twice refused to ship. It survives an unclosed `$(`,
      // which is the case it was added for.
      if (subDepth === 0) altDir = null
      if (part === '||' || part === '&') { dir = sessionCwd; dirExplicit = false; altDir = null; continue }
      if (/^(?:&&|[;\n])$/.test(part)) continue
      const pipeline = part
      // Stage boundaries come from the MASKED text; the stage CONTENT is sliced from the original
      // so quoted paths are still extractable.
      const stages = []
      let off = 0
      for (const stage of pipeline.split('|')) {
        const orig = cmd.slice(base + off, base + off + stage.length)
        if (orig.trim()) stages.push(orig.trim())
        off += stage.length + 1
      }
      if (!stages.length) continue
      const commandWord = (seg) => {
        const t = seg.split(/\s+/)
        let i = 0
        while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++
        return (t[i] || '').replace(/^['"]+/, '').split('/').pop()
      }
      const wholePipelineReadOnly = stages.every((st) => isReadOnlySegment(st, commandWord(st)))
      const multi = stages.length > 1
      const entryDir = dir
      const entryExplicit = dirExplicit
      for (const segment of stages) {
        // A multi-stage pipeline's stages are siblings, not a sequence: each resolves against the
        // directory the PIPELINE was entered in, and none of their cds survive past it. The same
        // asymmetry governs `explicit`: a stage sees its OWN cd and one from a previous split part
        // (entryExplicit), never a sibling stage's — that cd ran in a different subshell.
        // A cd in a part that is INSIDE an unclosed substitution moves only that subshell.
        const ec = effectiveCwd(segment, multi ? entryDir : dir)
        const chosen = insideSubst ? { dir: multi ? entryDir : dir, matched: false } : ec
        const stageDir = chosen.dir
        const stageExplicit = chosen.matched || (multi ? entryExplicit : dirExplicit)
        if (!multi) { dir = stageDir; dirExplicit = stageExplicit }
        const trimmed = segment.trim()
        if (!trimmed) continue
        if (wholePipelineReadOnly) continue
        // With a leftover quote the depth is a guess, so BOTH readings of this cd are plausible and
        // picking one is wrong half the time — in the direction that misses. Forcing the gate off
        // was the first attempt and it re-opened the nesting bypass; forcing it on is the bug this
        // check was added for. So try both bases and deny if EITHER names a symlink: over-resolving
        // costs an OTP prompt, and the alternative is a miss.
        // The alternate base has to PERSIST, not just apply to the stage whose cd was skipped: an
        // unclosed `$(` keeps the depth open, so the dangerous command lands in a LATER stage that
        // names no cd of its own. Remember the skipped target until a `||`/`&` resets the base.
        if (quotesUnbalanced && insideSubst && ec.matched && ec.dir !== stageDir) altDir = ec.dir
        const bases = [[stageDir, stageExplicit]]
        if (altDir && altDir !== stageDir) bases.push([altDir, true])
        for (const [b, explicit] of bases) {
          for (const tok of pathTokens(trimmed, b, explicit)) {
            const found = firstSymlink(tok.resolved)
            if (found) { hit = { ...found, raw: tok.raw }; break }
          }
          if (hit) break
        }
        if (hit) break
      }
      if (hit) break
    }
  } catch (e) {
    if (!maskBroken) {
      process.stderr.write(`[deny-symlink-paths] check failed, allowing: ${e.message}\n`)
      process.exit(0)
    }
  }
  if (maskBroken) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `deny-symlink-paths.js cannot check this command: masking changed its length `
          + `(${maskBroken}), so every path it extracted would come from the wrong offset. This is a `
          + `bug in the guard, not in your command — report it. Every mask here must be `
          + `length-preserving.`,
      },
    }))
    process.exit(0)
  }
  if (!hit) process.exit(0)

  const token = issueOtp(cmd)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `SYMLINK IN A PATH — stopped once so you can look before acting.\n`
        + `  argument: ${hit.raw}\n  symlink:  ${hit.link}\n  target:   ${hit.target}\n\n`
        + `Following a symlink can act on a file OUTSIDE the tree you think you are in. That is how, `
        + `on 2026-09-03, a package manager nearly deleted a repository's real node_modules through a `
        + `link in a scratch worktree.\n\n`
        + `If that is fine, re-issue the SAME command with the password prefixed:\n`
        + `  SYMLINK_OTP=${token} <your original command>\n\n`
        + `The password is single-use, expires in 15 minutes, and is bound to this exact command. `
        + `Guard: deny-symlink-paths.js`,
    },
  }))
  process.exit(0)
})
