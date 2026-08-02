#!/usr/bin/env node
// scripts/check-no-identities.js — refuse to ship the operator's identity.
//
// WHY THIS EXISTS. On 2026-08-02 a pre-push grep found the owner's three real account emails and
// account UUIDs in 31 places across 15 TRACKED files — source comments, TRDDs, tests, a project-memory
// page, and the diagnostics skill. `skills/` is in package.json's `files` allowlist, so the next
// `npm publish` would have shipped three personal gmail addresses to every user of this package. It
// was caught by a human-run grep that happened to be run that one time, which is not a control.
//
// WHAT IT CHECKS, AND WHY IT IS SHAPE-BASED. It detects the SHAPE of an identity — any email address,
// and any absolute home path carrying a username — never a list of the specific values that leaked.
// A guard keyed on today's values goes blind the moment a different account is used, which is the
// exact failure mode that lets the second incident through while the check still reports green.
//
// It deliberately does NOT flag bare UUIDs: test fixtures legitimately carry them, an opaque
// identifier without an address attached is not an identity, and a check that cries wolf gets
// disabled. The harm in the incident was the addresses and the usernames.
//
// SCOPE. Tracked files only (`git ls-files`), so gitignored working material — `*_dev/`, `reports/`,
// downloaded corpora — is out of scope by construction: it is never published. Build outputs named in
// `files` are also scanned when present, since those are what actually ship.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

// ── Allowlist ────────────────────────────────────────────────────────────────────────────────────
// Every entry needs a REASON. A bare list with no reasons rots into "everything is allowed" — the
// next person cannot tell a deliberate exemption from an accident someone silenced.

/** Domains that cannot belong to a real person. RFC 2606/6761 reserve these precisely for docs. */
const PLACEHOLDER_DOMAINS = [
  'example.com', 'example.org', 'example.net',   // RFC 2606 — reserved for documentation
  'invalid', 'test', 'localhost',                // RFC 2606/6761 — reserved, unresolvable
  'users.noreply.github.com',                    // GitHub's own no-reply form; the project's public
                                                 // commit identity uses it deliberately
]

/** Username segments that are obviously placeholders rather than a real account on a real machine.
 *  Three groups: generic stand-ins, the conventional fictional names, and the service accounts that
 *  containers and CI actually run as (a leak needs a PERSON behind it — `/home/node` names nobody). */
const PLACEHOLDER_USERS = new Set([
  'me', 'you', 'user', 'username', 'someone', 'test', 'x', 'yourname', 'your-name',
  'name', 'real-name', 'account-nickname', 'home', 'root',
  'alice', 'bob', 'carol', 'dave', 'eve', 'tester',
  'runner', 'node', 'ubuntu', 'debian', 'vscode', 'devcontainer', 'project', 'web_user', 'app',
])

/** Paths that are documentation ABOUT the rule, or generated files whose addresses are not ours. */
const EXEMPT_FILES = new Set([
  'scripts/check-no-identities.js',              // this file quotes the shapes it forbids
  // Lockfiles are MACHINE-GENERATED and carry third-party package authors' addresses. They are not a
  // channel for this project's identity, and "redacting" one would be overwritten by the next install.
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
])

// ── Detection ────────────────────────────────────────────────────────────────────────────────────

// A pragmatic address shape. Deliberately not RFC 5322 — that grammar matches things no human writes
// and misses nothing that matters here.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// An absolute home path with a username segment. All three OS spellings, because a leak on any one of
// them is the same leak.
//
// The lookbehind is load-bearing: without it, ordinary prose listing slash-separated words matches —
// `user/uid/gid/groups/shell/home/sudo-capable.` reported `/home/sudo-capable` as a leaked path. A
// real path is preceded by a boundary (start, space, quote, `=`, `:`, backtick), never by a word
// character. A guard that fires on prose is a guard someone turns off.
const HOME_PATH = /(?<![A-Za-z0-9_.\-])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g

/** Is this address a placeholder rather than someone's mailbox? */
function emailIsPlaceholder(addr) {
  const at = addr.indexOf('@')
  const local = addr.slice(0, at).toLowerCase()
  const domain = addr.slice(at + 1).toLowerCase()
  // A no-reply mailbox belongs to a service, not a person — GitHub's OIDC and commit addresses both
  // take this form and are quoted in docs on purpose.
  if (local.includes('noreply') || local.includes('no-reply')) return true
  // Suffix match so `foo.example.com` and `anything.invalid` are covered too.
  return PLACEHOLDER_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))
}

/** Is this home path pointing at a placeholder rather than a real account on a real machine? */
function userIsPlaceholder(user) {
  const u = user.toLowerCase()
  if (PLACEHOLDER_USERS.has(u)) return true
  if (u.startsWith('<') || u.startsWith('$') || u.startsWith('{')) return true  // /Users/<name>, /Users/$USER
  return false
}

/** Text files only. A binary match is noise and reading a bundle of images is a waste. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.wasm', '.parquet', '.db', '.sqlite',
])

// ── The stricter tier: SKILLS MUST BE UNIVERSAL ──────────────────────────────────────────────────
//
// A skill is installed into every user's `~/.claude/skills/` and read on someone else's machine, so
// it must contain NOTHING specific to one user or one host. That is a higher bar than "no personal
// email": a real session id, an account uuid, or a machine's own directory name is equally
// machine-specific and equally useless — worse than useless, because a reader can mistake one
// machine's identifier for a value that means something on theirs.
//
// MEASURED, and the reason this tier exists: the diagnostics skill carried THIS session's own id
// (`667293ab`) and two real session-id prefixes in an example, alongside three real account emails.
// None of them is a secret; all of them are noise that only ever described one machine.
//
// An example still needs id-SHAPED text to look like real output, so the rule is not "no ids" but
// "ids must be obviously fake": at most two distinct characters (`aaaaaaaa`, `bbbb2222`). A real id
// essentially never satisfies that, and a placeholder trivially does.
const SKILL_ID = /\b[0-9a-f]{8,}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g

function idIsPlaceholder(tok) {
  return new Set(tok.replace(/-/g, '')).size <= 2
}

/** A CONTENT hash is universal provenance, not a machine identifier: it names a file's bytes, and any
 *  reader on any machine can recompute it. A skill that pins the upstream text it vendored is doing
 *  exactly the right thing, so the hex is judged by what the line says it is. */
const HASH_CONTEXT = /\b(sha1|sha256|sha512|md5|hash|digest|checksum|commit|integrity)\b/i

function isSkillPath(rel) {
  return rel.startsWith('skills/') || rel.startsWith('.claude/skills/')
}

function scanFile(rel, text) {
  const findings = []
  const lines = text.split('\n')
  const skill = isSkillPath(rel)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const m of line.matchAll(EMAIL)) {
      if (!emailIsPlaceholder(m[0])) findings.push({ rel, line: i + 1, kind: 'email', value: m[0] })
    }
    for (const m of line.matchAll(HOME_PATH)) {
      if (!userIsPlaceholder(m[1])) findings.push({ rel, line: i + 1, kind: 'home-path', value: m[0] })
    }
    if (skill && !HASH_CONTEXT.test(line)) {
      for (const m of line.matchAll(SKILL_ID)) {
        if (!idIsPlaceholder(m[0])) findings.push({ rel, line: i + 1, kind: 'skill-machine-id', value: m[0] })
      }
    }
  }
  return findings
}

/** Everything git tracks, plus any build output named in package.json `files` that exists on disk.
 *  The built bundles are what actually ship, and they are gitignored — so tracked-only would miss a
 *  leak that reaches the tarball through a generated file. */
function filesToScan() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  const shipped = []
  let pkgFiles = []
  try { pkgFiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files || [] } catch { /* no files field */ }
  for (const entry of pkgFiles) {
    const abs = path.join(ROOT, entry)
    if (!fs.existsSync(abs)) continue
    if (fs.statSync(abs).isDirectory()) continue      // directories are covered by `tracked`
    shipped.push(entry)
  }
  return [...new Set([...tracked, ...shipped])]
}

function main() {
  const findings = []
  for (const rel of filesToScan()) {
    if (EXEMPT_FILES.has(rel)) continue
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue
    const abs = path.join(ROOT, rel)
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch { continue }   // gone, or unreadable — not our call
    if (text.includes('\0')) continue                                // binary that slipped the ext list
    findings.push(...scanFile(rel, text))
  }

  if (findings.length === 0) {
    console.log(`check-no-identities: OK — no personal email or home path in any tracked or shipped file`)
    return 0
  }

  console.error(`check-no-identities: FAIL — ${findings.length} identity leak(s) in files that are tracked or shipped:\n`)
  for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.kind}  ${f.value}`)
  console.error(`
These reach every reader of the repo, and anything under package.json "files" reaches every user who
installs the package. Replace them with placeholders:

  an address    -> owner@example.com / second@example.com  (example.com is reserved for this)
  a home path   -> /Users/<name>/…  or  ~/…

If the CONCRETE value is genuinely needed — "on THIS machine the config names account X" — it belongs
in LOCAL memory (~/.claude/projects/<slug>/memory/), which lives outside the repo and is never pushed.
Keep the machine-agnostic shape here and the machine-specific fact there.

A deliberate exemption goes in EXEMPT_FILES or the allowlists in this script, WITH its reason.`)
  return 1
}

process.exit(main())
