#!/usr/bin/env node
// Guard: a component that renders INSIDE another component's expansion gate must never write
// that ancestor's expansion signal.
//
// Why this exists as an executable check rather than a doctrine sentence: on 2026-09-08
// `SubAgentBranch` was landed deriving `open` from `expandedTraceId` and calling
// `setExpandedTraceId(child.sessionId)` on click. SubAgentBranch renders under TurnGroup →
// TimelineWaterfall, which SessionBlock mounts only inside its own `{!collapsed && ...}` gate,
// and `collapsed` is derived from that same signal. So clicking a sub-agent row collapsed its
// own parent and unmounted the branch that had just been opened — sub-agent branches were
// simply unopenable. check-types, check-mirrors and esbuild ALL passed on that code: the bug is
// a render-topology fact, invisible to every type- and bundle-level gate. Only a check that
// knows which component nests inside which can see it.
//
// Correspondingly this guard is deliberately narrow: it encodes the ONE nesting relationship
// that exists today rather than trying to infer the render tree. Add a row when a new
// gated-descendant relationship appears.

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

// component: the function whose body is checked.
// forbidden: setters it must not call, because they drive a gate it renders inside.
// reason: printed on failure so the next reader does not have to rediscover the topology.
const RULES = [
  {
    file: 'media/src/tabs/Traces.tsx',
    component: 'SubAgentBranch',
    forbidden: ['setExpandedTraceId', 'expandedTraceId'],
    reason:
      'SubAgentBranch renders inside SessionBlock\'s `!collapsed` gate, which is derived from ' +
      'expandedTraceId. Writing or reading that signal here collapses the parent and unmounts ' +
      'this branch. Use expandedBranchId / setExpandedBranchId instead.',
  },
]

/**
 * Strip comments so the guard measures CODE, not prose.
 *
 * Without this the rule fires on the comment that explains the hazard — i.e. it punishes exactly
 * the documentation a future reader needs, and a guard that reddens on correct writing gets
 * deleted. `(?<!:)` keeps `https://…` intact, the one common non-comment `//` in this codebase.
 * Tradeoff, stated rather than discovered: a `//` inside some other string literal would truncate
 * that line, which fails toward a MISSED violation. Acceptable here because the forbidden symbols
 * are signal identifiers that never appear inside strings; revisit if a rule ever names one that
 * could.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

/**
 * Return the source of `function <name>(` up to the next top-level `function ` / `export function `.
 * Returns null when the component is absent — treated as a hard failure by the caller, because a
 * renamed component silently disables the rule otherwise.
 */
function componentBody(src, name) {
  const start = src.search(new RegExp(`^(?:export )?function ${name}\\b`, 'm'))
  if (start === -1) return null
  const rest = src.slice(start + 1)
  const nextIdx = rest.search(/^(?:export )?function \w/m)
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx)
}

// Optional single-file override, so the guard can be run against an arbitrary revision of the
// file (`git show <sha>:<path> > /tmp/x.tsx`) to prove it actually FAILS on known-broken code.
// A guard nobody has seen fail is not evidence that it works.
const override = process.argv[2] ?? null

let failures = 0
let checked = 0

for (const rule of RULES) {
  const abs = override ?? path.join(ROOT, rule.file)
  if (!fs.existsSync(abs)) {
    console.error(`check-single-expansion: FAIL — ${rule.file} does not exist (rule is stale)`)
    failures++
    continue
  }
  const src = stripComments(fs.readFileSync(abs, 'utf8'))
  const body = componentBody(src, rule.component)
  if (body === null) {
    console.error(
      `check-single-expansion: FAIL — ${rule.component} not found in ${rule.file}. ` +
        'It was renamed or removed; update or delete this rule deliberately rather than ' +
        'letting the check pass vacuously.'
    )
    failures++
    continue
  }
  for (const symbol of rule.forbidden) {
    // Word-boundary match so `expandedBranchId` never trips a rule about `expandedTraceId`.
    if (new RegExp(`\\b${symbol}\\b`).test(body)) {
      console.error(
        `check-single-expansion: FAIL — ${rule.component} (${rule.file}) references ${symbol}.\n` +
          `  ${rule.reason}`
      )
      failures++
    }
  }
  checked++
}

if (failures > 0) {
  process.exit(1)
}
console.log(`check-single-expansion: OK — ${checked} nesting rule(s) hold`)
