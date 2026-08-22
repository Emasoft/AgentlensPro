#!/usr/bin/env node
// PreToolUse(Bash) guard: refuse command shapes that MEASURE THE HARNESS instead of the thing.
//
// WHY THIS EXISTS. On 2026-08-22 a single session produced nine wrong claims, and every one had
// the same shape: a proxy was read in place of the thing it stood for. Four of those were a
// literal command shape, decidable without judgment, and this guard refuses exactly those four.
// The rest needed a human. A guard is the right tool ONLY for the mechanical residue.
//
// The failures, each with the claim it produced:
//
//   1. `cargo fmt -- --check <file>` — cargo hands rustfmt the CRATE ROOTS regardless of the path
//      you append, so every file reports the crate's diffs. Verdict: "all 3 of my files are
//      unformatted" and, an hour earlier from the same shape, "all 3 are clean". Both false; the
//      branch really had 4 unformatted hunks hiding in ~624 pre-existing ones.
//
//   2. `cargo test --workspace | tail -3` — two failures at once. `tail` BUFFERS to EOF, so the
//      run looked wedged for 53 minutes while it was progressing normally; and `$?` after a pipe
//      is TAIL's status, so "exit code 0" was read as "the tests passed" when it proved nothing
//      about cargo.
//
//   3. `cmd | tee FILE | head` — the consumer exits, SIGPIPEs `tee` mid-write, and FILE is
//      silently TRUNCATED. A later `wc -l FILE` then reports a confidently wrong count.
//
//   4. `ps aux | grep <pattern>` / `pgrep -f <pattern>` — the shell running the pipeline has the
//      pattern in its own argv, so the lookup matches ITSELF. Not a macOS quirk: a fundamental
//      property of scanning a table that contains the scanner.
//
// SCOPE, deliberately narrow. Rule 2 fires only for commands whose OUTPUT IS THE MEASUREMENT —
// cargo/pnpm/npm/npx/make/mocha. `cat f | head`, `grep x f | head` and `head -20 f` are normal
// file inspection and must stay allowed, because a guard that reddens on correct work gets
// deleted. Matching is TOKEN-based for the same reason the sibling guard documents: the first
// version of deny-playwright-init-agents.js blocked `git add` of its own filename.

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = String(JSON.parse(raw)?.tool_input?.command ?? '')
  } catch {
    // Unparseable payload: allow. A guard that blocks every Bash call because it could not read
    // its own input is worse than what it guards against.
    process.exit(0)
  }

  const deny = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${reason} Guard: scripts/deny-unscoped-measurement.js`,
      },
    }))
    process.exit(0)
  }

  const tokensOf = (s) => s.trim().split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ''))
  // Split on pipes only — `;` and `&&` separate whole commands, and a pipeline cannot span them.
  const pipelines = cmd.split(/[;\n]+|&&|\|\|/)

  for (const pipeline of pipelines) {
    const stages = pipeline.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim()).filter(Boolean)
    const first = tokensOf(stages[0] ?? '')
    const bin = (t) => (t ?? '').split('/').pop()

    // ── Rule 1: cargo fmt with a path argument ───────────────────────────────────────────────
    const cargoAt = first.findIndex((t) => bin(t) === 'cargo')
    if (cargoAt !== -1 && first[cargoAt + 1] === 'fmt') {
      const after = first.slice(cargoAt + 2)
      const dashDash = after.indexOf('--')
      // A path after `--` is the trap. `cargo fmt --check` (no path) is correct and stays allowed.
      if (dashDash !== -1 && after.slice(dashDash + 1).some((t) => /\.rs$|\//.test(t))) {
        deny(
          'Blocked `cargo fmt -- --check <path>`: cargo passes the CRATE ROOTS to rustfmt whatever '
          + 'path you append, so the result describes the crate, not your file — it reported both '
          + '"clean" and "all unformatted" for the same files an hour apart. Use '
          + '`rustfmt --check --edition 2021 <file>`, and to tell YOUR diffs from pre-existing ones '
          + 'compare its hunk line numbers against the same file on the merge base.',
        )
      }
    }

    // ── Rule 2: a measurement piped into a truncating/buffering consumer ─────────────────────
    const MEASURE = new Set(['cargo', 'pnpm', 'npm', 'npx', 'make', 'mocha', 'pytest', 'go'])
    const TRUNCATOR = new Set(['head', 'tail'])
    if (stages.length > 1 && first.some((t) => MEASURE.has(bin(t)))) {
      const last = tokensOf(stages[stages.length - 1])
      // `tail -f` follows a live log and never truncates — that is a legitimate use.
      const follows = last.includes('-f') || last.includes('--follow')
      if (TRUNCATOR.has(bin(last[0])) && !follows) {
        deny(
          `Blocked \`${bin(first.find((t) => MEASURE.has(bin(t))))} … | ${bin(last[0])}\`: this `
          + 'measures the HARNESS. The consumer buffers to EOF so the run looks wedged while it is '
          + 'fine, and `$?` afterwards is the consumer\'s status, not the tool\'s — that is how '
          + '"exit code 0" got read as "the tests passed". Capture first, inspect second: '
          + '`cmd > /tmp/out.txt 2>&1; echo "EXIT=$?"` then grep the file.',
        )
      }
    }

    // ── Rule 3: tee feeding a consumer that exits early ──────────────────────────────────────
    for (let i = 0; i < stages.length - 1; i++) {
      if (bin(tokensOf(stages[i])[0]) === 'tee') {
        const next = tokensOf(stages[i + 1])
        if (TRUNCATOR.has(bin(next[0])) && !next.includes('-f')) {
          deny(
            'Blocked `tee FILE | head/tail`: the consumer exits, SIGPIPEs tee mid-write, and FILE '
            + 'is silently TRUNCATED — a later `wc -l` then reports a confidently wrong count. '
            + 'Write the file first (`cmd > FILE 2>&1`), then inspect it separately.',
          )
        }
      }
    }

    // ── Rule 4: a process lookup that matches its own shell ──────────────────────────────────
    const psGrep = stages.length > 1
      && bin(first[0]) === 'ps'
      && stages.slice(1).some((s) => ['grep', 'rg', 'egrep'].includes(bin(tokensOf(s)[0])))
    // `pgrep -af '[w]rite_bot'` already breaks the self-match with the bracket trick.
    const barePgrep = ['pgrep', 'pkill'].includes(bin(first[0]))
      && first.some((t) => /^-\w*f/.test(t))
      && !/\[[^\]]\]/.test(pipeline)
    if (psGrep || barePgrep) {
      deny(
        'Blocked a self-matching process lookup: the shell running this pipeline has the search '
        + 'pattern in its own argv, so it finds ITSELF as a false positive. Snapshot first — '
        + '`ps -eo pid,ppid,etime,command > /tmp/ps.txt` — then grep the file (the snapshot '
        + 'predates the grep, so no self-match is possible). Or use the bracket trick: '
        + "pgrep -af '[w]hatever'.",
      )
    }
  }

  process.exit(0)
})
