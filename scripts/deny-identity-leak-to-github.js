#!/usr/bin/env node
// PreToolUse(Bash) guard: refuse a `gh` command that would POST a personal identity to GitHub.
//
// WHY THIS EXISTS. On 2026-08-02 an agent pasted a `get_account_status --all` table straight into a
// comment on the PUBLIC Emasoft/AgentlensPro#8. The table carries one row per account, and each row
// carries that account's email — so three personal addresses were published, indexed, and cannot be
// unsent. `pnpm run check-identities` did not fire and could not: it scans TRACKED AND SHIPPED
// FILES. A GitHub comment is neither. The doctrine ("no identities in anything tracked or shipped")
// was right and its enforcement simply had no reach over this surface.
//
// So this guard covers the OTHER direction — text leaving the machine through `gh`. It is
// shape-based, never a list of the addresses that leaked: a guard keyed on today's account goes
// blind the moment a different one is used, which is exactly how the second incident gets through
// while the check still reports green.
//
// SCOPE: only `gh` invocations that POST prose. `gh issue view`, `gh pr diff`, `gh api` GETs and
// every non-gh command pass untouched — a guard that inspects every Bash call would be both slow
// and, worse, would start denying greps whose PATTERN looks like an email. Matching the posting
// verb first is what keeps this from blocking work that merely mentions the shapes.
//
// FAIL-OPEN on an unreadable payload, FAIL-CLOSED on a match: the cost of a false deny is one
// rephrase; the cost of a false allow is a published address.

const fs = require('fs')

/** `gh <noun> <verb>` pairs that publish text. Read verbs are deliberately absent. */
const POSTING = new Set([
  'issue create', 'issue comment', 'issue edit',
  'pr create', 'pr comment', 'pr edit', 'pr review',
  'release create', 'release edit',
  'gist create',
  'discussion create', 'discussion comment',
])

/** An address that is SUPPOSED to be public: the GitHub noreply identity this project commits with
 *  (see CLAUDE.md), and the reserved example domains. Everything else is a real person. */
function isAllowedEmail(addr) {
  const a = addr.toLowerCase()
  return a.endsWith('@users.noreply.github.com')
    || /@example\.(com|org|net)$/.test(a)
    || /@(localhost|invalid|test)$/.test(a)
}

/** Placeholder home directories that carry no identity. */
const PLACEHOLDER_USERS = new Set(['x', 'you', 'user', 'username', 'me', 'name', 'runner', 'home', 'root', 'ci'])

function findEmails(text) {
  const hits = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []
  return [...new Set(hits.filter((h) => !isAllowedEmail(h)))]
}

/** Remove fenced blocks and inline code, so only text GitHub RENDERS as prose is inspected.
 *  Inside a code span an `@name` is inert — that is precisely why backticking it is the fix. */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/**
 * `@name` in rendered prose PAGES that GitHub account. The handles agents reach for are exactly the
 * ones that are already taken: `@manager` and `@janitor` are real users, and both were notified by
 * agents writing role names in issue bodies. Nothing marks them as a mistake at post time — the
 * notification simply lands on a stranger, repeatedly, from a repo they have nothing to do with.
 *
 * An email's `@` is preceded by a word character and so never matches here; addresses are the email
 * rule's job.
 */
function findMentions(text) {
  const hits = []
  const re = /(?:^|[^\w`@])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g
  let m
  const prose = stripCode(text)
  while ((m = re.exec(prose)) !== null) hits.push('@' + m[1])
  return [...new Set(hits)]
}

function findHomePaths(text) {
  const hits = []
  const re = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const who = m[1]
    // A placeholder or an angle-bracket template is not an identity.
    if (PLACEHOLDER_USERS.has(who.toLowerCase())) continue
    if (who.startsWith('<') || who.startsWith('$') || who.startsWith('%')) continue
    hits.push(m[0])
  }
  return [...new Set(hits)]
}

/** Mask so the DENIAL itself never reprints the secret into a transcript that may be shared. */
function mask(s) {
  if (s.includes('@')) {
    const [local, domain] = s.split('@')
    return `${local.slice(0, 1)}***@${domain}`
  }
  return s.replace(/([A-Za-z0-9._-]+)$/, (u) => `${u.slice(0, 1)}***`)
}

/** The `gh` posting verb this segment invokes, or null. Compares the BASENAME so `/opt/gh`,
 *  `"gh"` and a bare `gh` are all the same binary. */
function postingVerb(tokens) {
  const bin = tokens.findIndex((t) => t.split('/').pop() === 'gh')
  if (bin === -1) return null
  const rest = tokens.slice(bin + 1).filter((t) => !t.startsWith('-'))
  if (rest.length < 2) return null
  const pair = `${rest[0]} ${rest[1]}`
  return POSTING.has(pair) ? pair : null
}

/** Every `--body-file`/`-F` path in the segment — the body usually lives in a file, so scanning the
 *  command string alone would miss the exact shape this incident took. */
function bodyFiles(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--body-file' || t === '-F' || t === '--notes-file') {
      if (tokens[i + 1]) out.push(tokens[i + 1])
    } else if (t.startsWith('--body-file=')) {
      out.push(t.slice('--body-file='.length))
    }
  }
  return out
}

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = String(JSON.parse(raw)?.tool_input?.command ?? '')
  } catch {
    process.exit(0) // unreadable payload — never block every Bash call over our own parse failure
  }

  const segments = cmd.split(/[;&|\n]+/)
  let verb = null
  let scanned = cmd // the command text itself covers --body "..." and inline heredoc content
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    const v = postingVerb(tokens)
    if (!v) continue
    verb = v
    for (const f of bodyFiles(tokens)) {
      try { scanned += '\n' + fs.readFileSync(f, 'utf8') } catch { /* unreadable file: the command text still gets scanned */ }
    }
  }
  if (!verb) process.exit(0)

  const emails = findEmails(scanned)
  const homes = findHomePaths(scanned)
  const mentions = findMentions(scanned)
  if (emails.length === 0 && homes.length === 0 && mentions.length === 0) process.exit(0)

  const found = [
    ...emails.map((e) => `email ${mask(e)}`),
    ...homes.map((h) => `home path ${mask(h)}`),
    ...mentions.map((h) => `@-mention ${h} (pages that GitHub user)`),
  ].join(', ')

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Blocked \`gh ${verb}\`: the text you are about to publish would expose or notify someone — ${found}. `
        + 'Both halves are from real incidents on 2026-08-02: three personal addresses were published to '
        + 'PUBLIC issue comments, and the strangers who own @manager and @janitor were paged by agents '
        + 'writing role names in prose. Neither can be unsent, and `pnpm run check-identities` catches '
        + 'neither — it scans tracked and shipped FILES, not outbound posts. Fixes: genericize the path; '
        + 'replace an address with the account uuid or a role name; and wrap any @name in BACKTICKS, which '
        + 'renders it as code and notifies nobody. The noreply commit identity and example.com addresses '
        + 'are allowed. Guard: scripts/deny-identity-leak-to-github.js',
    },
  }))
  process.exit(0)
})
