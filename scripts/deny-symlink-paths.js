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
const MUTATING_FLAGS = {
  find: /(?:^|\s)-(?:delete|exec|execdir|fprint|fls|ok|okdir)\b/,
  sort: /(?:^|\s)-o\b/,
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
function pathTokens(cmd) {
  const out = []
  const seen = new Set()
  const add = (tok) => {
    if (!tok || tok.startsWith('-') || seen.has(tok)) return
    seen.add(tok)
    if (!tok.includes('/') && !tok.startsWith('~') && !tok.startsWith('$')) return
    const e = expand(tok)
    if (e && e.includes('/')) out.push({ raw: tok, resolved: e })
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
  try {
    cmd = String(JSON.parse(raw)?.tool_input?.command ?? '')
  } catch {
    process.exit(0) // unreadable payload: a guard that blocks every call because it cannot read its
                    // own input is worse than the thing it guards against
  }
  if (!cmd) process.exit(0)

  let hit = null
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
    const segmentable = cmd.replace(/\d?>&\d?/g, ' ')
    // PIPELINES FIRST. A read-only command is only harmless if its OUTPUT goes nowhere dangerous:
    // `ls /tmp/link | oppa` reads through the symlink and hands the result to a binary we know
    // nothing about (owner, 2026-09-03: "you don't know what oppa does, but since ls pipes its
    // output into oppa, you must trigger the protection"). Judging stages independently made this
    // ALLOW — `ls` was exempt and `oppa` named no path. So a stage keeps its exemption only when
    // EVERY stage of its pipeline is itself known-read-only: `ls x | grep y` stays quiet, and one
    // unknown command anywhere in the chain re-arms the whole pipeline.
    for (const pipeline of segmentable.split(/(?:\|\||&&|[;&\n])+/)) {
      const stages = pipeline.split('|').map((x) => x.trim()).filter(Boolean)
      if (!stages.length) continue
      const commandWord = (seg) => {
        const t = seg.split(/\s+/)
        let i = 0
        while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++
        return (t[i] || '').replace(/^['"]+/, '').split('/').pop()
      }
      const wholePipelineReadOnly = stages.every((st) => isReadOnlySegment(st, commandWord(st)))
      for (const segment of stages) {
        const trimmed = segment.trim()
        if (!trimmed) continue
        if (wholePipelineReadOnly) continue
        for (const tok of pathTokens(trimmed)) {
          const found = firstSymlink(tok.resolved)
          if (found) { hit = { ...found, raw: tok.raw }; break }
        }
        if (hit) break
      }
      if (hit) break
    }
  } catch (e) {
    process.stderr.write(`[deny-symlink-paths] check failed, allowing: ${e.message}\n`)
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
