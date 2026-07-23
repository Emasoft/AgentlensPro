#!/usr/bin/env node
// PreToolUse(Bash) guard: refuse `playwright init-agents`.
//
// WHY THIS EXISTS. Playwright ships three agent definitions (planner / generator / healer) and a
// CLI command that transcribes them into whichever coding agent you use — `.claude/agents/*.md`,
// `.github/agents/*.agent.md`, `.opencode/prompts/*.md`, `.vscode/mcp.json`, plus `.mcp.json` and
// `.github/workflows/copilot-setup-steps.yml`. Those files are read by an agent as INSTRUCTIONS
// with the user's privileges, and this project does not use them.
//
// The command is the ONLY trigger — playwright's package.json has no install scripts, so nothing
// is written by installing. That makes invocation the single thing worth guarding, and the
// realistic risk is an AGENT running it while following a tutorial, not a human typing it
// deliberately. A human who means it can still run it in a shell outside the tool layer.
//
// Note the default: `playwright init-agents` with NO --loop flag falls through to the Copilot
// generator, so even the bare form writes into `.github/` — including a workflow file.
//
// Matching is TOKEN-based, not substring. A substring match is unusable: the first version of
// this guard blocked `git add scripts/deny-playwright-init-agents.js` — its own filename contains
// both words — and blocked writing any file whose text quotes the command. Tokens draw the line
// where it belongs: the real command has `playwright` and `init-agents` as separate arguments,
// while a path joins them with hyphens.
//
// Still deliberately conservative in the remaining ambiguity (a genuine `echo playwright
// init-agents` is denied). Blocking a harmless echo is the cheap failure; letting the real
// command through is not, and the denial message says how to proceed.

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let cmd = ''
  try {
    const payload = JSON.parse(raw)
    cmd = String(payload?.tool_input?.command ?? '')
  } catch {
    // Unparseable payload: say nothing and let the call proceed. A guard that blocks every Bash
    // call because it could not read its own input is worse than the thing it guards against.
    process.exit(0)
  }

  // Split into shell-ish tokens and look for the binary followed later by the subcommand, within
  // one command segment. `playwright` may arrive as any launcher spelling — a bare name on PATH,
  // `npx playwright`, `pnpm exec playwright`, `./node_modules/.bin/playwright` — so compare the
  // token's BASENAME. Quotes are stripped so `"playwright" init-agents` cannot slip past.
  const segments = cmd.split(/[;&|\n]+/)
  const invokesGenerator = segments.some((seg) => {
    const tokens = seg.trim().split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    const bin = tokens.findIndex((t) => t.split('/').pop() === 'playwright')
    return bin !== -1 && tokens.slice(bin + 1).includes('init-agents')
  })
  if (!invokesGenerator) process.exit(0)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Blocked `playwright init-agents`: it writes agent definitions this project does not use '
        + '(.claude/agents/, .github/agents/, .opencode/, .mcp.json, and a copilot-setup-steps.yml '
        + 'workflow) which an agent then loads as instructions. Nothing is written by installing '
        + 'playwright — only by this command. If you genuinely want them, run it in a terminal '
        + 'yourself and read the generated .md files before any agent loads them. '
        + 'Guard: scripts/deny-playwright-init-agents.js',
    },
  }))
  process.exit(0)
})
