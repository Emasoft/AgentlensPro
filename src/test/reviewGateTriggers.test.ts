import * as assert from 'assert'
import {
  commandWriteReason, isEphemeralTarget, shellWords, textArms,
  GIT_WRITE_SUBCOMMANDS, GH_MUTATING_VERBS, PKG_WRITE_VERBS, ALL_ARGS_ARE_TARGETS, LAST_ARG_IS_TARGET,
} from '../cli/reviewGateTriggers'

// WHAT ARMS the review gate (TRDD-0E3W5C45). The ARM rows are the guard against the fail-OPEN
// direction (a write that goes unreviewed); the PASS rows guard the fail-CLOSED direction (the
// idle-turn livelock — every PASS row also passed the OLD gate, which armed Bash only on `git
// commit`). Both are needed: a gate that never arms is green on the PASS table alone.
// Paths use `/proj` and `/tmp` — a `/Users/<name>` fixture would trip check-identities.

const CWD = '/proj'

suite('review-gate triggers: write-shaped commands', () => {
  // Real shapes from this session's own JSONL (41 distinct main-conversation commands), genericized.
  const ARM: [string, string][] = [
    ['git commit -m x', 'git commit'],
    ['git -C /proj push', 'git push'],
    ['git add a && git commit -F - <<\'EOF\'\nsubject\nEOF', 'git commit'],
    ['git status\ngit commit -m x', 'git commit'],           // a NEWLINE is a command boundary (review 2026-09-08)
    ['X=$(git commit -m x)', 'git commit'],                  // so is `$(`
    ['echo `git commit -m x`', 'git commit'],                // and a backtick
    ['bash -c \'git commit -m x\'', 'git commit'],           // a shell given a string runs it
    ['eval "git push"', 'git push'],
    ['for f in a b; do git commit -m x; done', 'git commit'],  // `do` heads the body (post-write review)
    ['if true; then git push; fi', 'git push'],
    ['if git commit -m x; then :; fi', 'git commit'],          // the CONDITION is a command too
    ['while ! git push; do sleep 1; done', 'git push'],
    ['{ git commit -m x; }', 'git commit'],
    ['find . -print0 | xargs -0 rm', 'rm via xargs (targets unknown)'],  // `-0` is xargs's option, not the command
    ['xargs -I {} rm {} < list', 'rm via xargs (targets unknown)'],
    ['find . | xargs -n 1 rm', 'rm via xargs (targets unknown)'],  // a SEPARATE option value (third review)
    ['find . | xargs -P 4 rm', 'rm via xargs (targets unknown)'],
    ['find . -exec rm {} \\;', 'rm via find -exec (targets unknown)'],
    ['find . -exec ls {} \\; -exec rm {} \\;', 'rm via find -exec (targets unknown)'],  // EVERY -exec (fourth review)
    ['find . -exec sudo rm {} \\;', 'rm via find -exec (targets unknown)'],           // through the wrapper walk
    ['find . -name \'*.log\' -delete', 'find -delete'],
    ['echo "->"| tee notes.md', 'tee notes.md'],               // a quoted `>` must not glue the pipe
    ['git -c a=b commit -m x', 'git commit'],                   // `-c k=v` takes a value
    ['git commit -F - <<\'EOF\'\nsubject\n- a line with > in it\nEOF', 'git commit'],  // segments before redirects
    ['echo x >| src/a', 'redirect into src/a'],
    ['perl -i -pe \'s/a/b/\' f', 'perl -i'],
    ['git mv a b', 'git mv'],
    ['git checkout -- x', 'git checkout'],
    ['git stash', 'git stash'],
    ['sed -i \'\' \'s/a/b/\' f', 'sed -i'],
    ['perl -pi -e \'s/a/b/\' f', 'perl -i'],
    ['echo x > src/a.ts', 'redirect into src/a.ts'],
    ['echo x >> notes.md', 'redirect into notes.md'],
    ['cat > "$F" <<\'EOF\'\nbody\nEOF', 'redirect into $F'],  // undecidable target ⇒ arm
    ['echo x > $OUT', 'redirect into $OUT'],
    ['cd reports && echo x > y', 'redirect into y'],          // the cd is not tracked ⇒ resolves wrong ⇒ arm
    ['echo x > ' + '~' + '/n.txt', 'redirect into ' + '~' + '/n.txt'],
    ['echo x > reports_dev', 'redirect into reports_dev'],    // the dir ITSELF is not inside the dir
    ['cmd | tee out.txt', 'tee out.txt'],
    ['cp a src/b', 'cp src/b'],
    ['mv a b', 'mv b'],
    ['rm -rf src/x', 'rm src/x'],
    ['rm /proj/.git/index.lock', 'rm /proj/.git/index.lock'],
    ['touch new.ts', 'touch new.ts'],
    ['find . | xargs rm', 'rm via xargs (targets unknown)'],
    ['pnpm add x', 'pnpm add'],
    ['pnpm install foo', 'pnpm install <pkg>'],
    ['uv add y', 'uv add'],
    ['gh issue create -t x', 'gh issue create'],
    ['gh pr comment 1 -b y', 'gh pr comment'],
    ['gh api repos/a/b/issues -f title=x', 'gh api (mutating)'],
    ['gh workflow run publish.yml', 'gh workflow run'],
    ['agentlenspro --install-hooks', 'agentlenspro config write'],
    ['agentlenspro setup', 'agentlenspro config write'],
    ['memgrep new-mem-atom x', 'memgrep new-mem-atom'],
  ]
  const PASS = [
    '/x/dispatcher-stub.py 2>&1',                                   // the janitor heartbeat, 10 fires this session
    'agentlenspro review-gate --directive 2>&1 | head -80',
    'agentlenspro review-gate --directive > /tmp/d.txt 2>&1; echo "exit=$?"; wc -l < /tmp/d.txt',
    'ps -eo pid,command > /private/tmp/claude-1/s/ps.txt',
    'git status --short && git log -1 --oneline',
    'git worktree list --porcelain | sed -n \'s/^worktree //p\'',
    'git stash list', 'git stash show', 'git diff', 'git rev-parse HEAD', 'git -C /proj log -3',
    'X=$(date); echo $X > /tmp/y', 'find . -name \'*.ts\' -exec grep -l foo {} +', 'bash -c "ls | wc -l"',
    'grep -E \'git (add|commit|merge)\' f', 'echo "git commit"', 'echo "cp x y"', 'grep \'mv \' f', 'cp --help',
    'cmd 2>/dev/null', 'cmd >/dev/null 2>&1', 'cmd 2>&1 | head', 'cmd &> /tmp/x',
    'cmd | tee /tmp/x', 'cmd | tee reports/x/y.md', 'rm -f /tmp/x', 'mv x reports_dev/x',
    'pnpm run lint', 'pnpm install', 'uv run --script --quiet "/x/compose.py" --project-root "/y"', 'cargo build',
    'gh issue view 1', 'gh api repos/a/b', 'gh run view 1', 'agentlenspro setup --dry-run',
    'agentlenspro statusline-history project 2>&1 | distill "A -> B"', 'memgrep recall "x" dir',
    'sed -n \'1,45p\' f', 'perl -ne \'print\' f', 'node -e \'console.log(1)\'', 'python3 -c "print(1)"',
    'D=' + '~' + '/.claude/x; grep -rn "reports" "$D/s/" 2>/dev/null | head',
    'find .claude -type f -exec ls -la {} \\; 2>/dev/null',       // an escaped `;` is not a separator
    'sudo -n git status',                                            // `-n` takes NO value for sudo: git status must be reached
    'echo a \\> b',                                                  // an escaped `>` is not a redirect
    'echo a\\>| b', 'echo "a>"| tr a b',                             // …and does not glue the pipe after it
    'diff <(node -e \'1\') <(node -e \'2\')',
    'awk \'{print > "x"}\' f', 'echo "a > b"', 'date +%s', 'ls -la', 'cat file',
  ]

  test('every ARM row arms, with the reason the message will print', () => {
    for (const [cmd, why] of ARM) assert.strictEqual(commandWriteReason(cmd, CWD), why, cmd)
  })

  test('every PASS row is read-only as far as its text shows — the livelock guard', () => {
    for (const cmd of PASS) assert.strictEqual(commandWriteReason(cmd, CWD), null, cmd)
  })

  test('every member of every verb set arms — a hand-picked sample left most untested', () => {
    for (const sub of GIT_WRITE_SUBCOMMANDS) assert.strictEqual(commandWriteReason(`git ${sub} x`, CWD), `git ${sub}`)
    for (const verb of GH_MUTATING_VERBS) assert.strictEqual(commandWriteReason(`gh pr ${verb} 1`, CWD), `gh pr ${verb}`)
    for (const verb of PKG_WRITE_VERBS) assert.strictEqual(commandWriteReason(`npm ${verb} x`, CWD), `npm ${verb}`)
    for (const c of ALL_ARGS_ARE_TARGETS) assert.strictEqual(commandWriteReason(`${c} /tmp/a src/b`, CWD), `${c} src/b`)
    for (const c of LAST_ARG_IS_TARGET) assert.strictEqual(commandWriteReason(`${c} src/a /tmp/b`, CWD), null, `${c}: last arg ephemeral`)
    for (const c of LAST_ARG_IS_TARGET) assert.strictEqual(commandWriteReason(`${c} /tmp/a src/b`, CWD), `${c} src/b`)
  })
})

suite('review-gate triggers: ephemeral targets fail CLOSED', () => {
  test('literal paths under the roots are exempt; anything the shell would expand is not', () => {
    for (const t of ['/dev/null', '/tmp/x', '/private/tmp/a b', 'reports/x', './reports/x/y.md', 'docs_dev/n.md', '/proj/reports_dev/z']) {
      assert.strictEqual(isEphemeralTarget(t, CWD), true, t)
    }
    for (const t of ['', 'reports_dev', 'reports', '../x', 'src/x.ts', '/etc/hosts', '/proj/src/reports/x', '$F', '"$F"', '~' + '/x', '/tmp/*.txt', '/tmp/{a,b}', '`x`', '/tmp/x?']) {
      assert.strictEqual(isEphemeralTarget(t, CWD), false, t)
    }
  })
})

suite('review-gate triggers: text', () => {
  test('only a line STARTING with PROPOSAL arms — not prose, not a fence, not a quotation', () => {
    for (const t of ['PROPOSAL: change X', '**PROPOSAL:** change X', '## PROPOSAL\nchange X', 'intro\n\nPROPOSAL: later line']) {
      assert.strictEqual(textArms(t), true, t)
    }
    for (const t of ['janitor heartbeat', 'Holding.', 'I propose changing X to Y.', 'my proposal is X', '> PROPOSAL: quoted',
      'here:\n```ts\nconst x = 1\n```', 'a proposal: no']) {
      assert.strictEqual(textArms(t), false, t)
    }
  })
})

suite('review-gate triggers: shellWords', () => {
  test('quotes, escapes, fd dups and boundaries', () => {
    assert.deepStrictEqual(shellWords('a "b c" d').map((w) => w.word), ['a', 'b c', 'd'])
    assert.deepStrictEqual(shellWords('x 2>&1 | y').map((w) => w.word), ['x', '2>&1', '|', 'y'])
    assert.deepStrictEqual(shellWords('x >| y').map((w) => w.word), ['x', '>|', 'y'])  // clobber, not a pipe
    assert.deepStrictEqual(shellWords('echo a\\>| b').map((w) => w.word), ['echo', 'a>', '|', 'b'])  // escaped `>`: a pipe
    assert.deepStrictEqual(shellWords('a&&b||c;d\ne').map((w) => w.word), ['a', '&&', 'b', '||', 'c', ';', 'd', ';', 'e'])
    assert.deepStrictEqual(shellWords('f \\; g').map((w) => [w.word, w.quoted]), [['f', false], [';', true], ['g', false]])
    assert.deepStrictEqual(shellWords('X=$(y) z').map((w) => w.word), ['X=$', ';', 'y', ';', 'z'])
  })
})
