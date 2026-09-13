import * as assert from 'assert'
import {
  commandWriteReason, isEphemeralTarget, shellWords, textArms,
  GIT_WRITE_SUBCOMMANDS, GH_MUTATING_VERBS, PKG_WRITE_VERBS, ALL_ARGS_ARE_TARGETS, LAST_ARG_IS_TARGET,
} from '../cli/reviewGateTriggers'
import { stripHeredocBodies } from '../cli/reviewGateTriggers'

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
    ['S=$(mktemp); echo x > "$S"', 'redirect into $S'],                       // undecidable assignment ⇒ arm
    ['S=/tmp/a; S=$X; echo x > "$S"', 'redirect into $S'],                    // reassignment deletes the resolved value
    ['S=/tmp/a; echo x > "$S/../../etc/x"', 'redirect into $S/../../etc/x'],  // not a bare $VAR ⇒ never resolved
    ['echo x > /tmp/$X', 'redirect into /tmp/$X'],                           // still has a $ after stripping ⇒ arm
    ['echo x > /tmp/../etc/$$', 'redirect into /tmp/../etc/$$'],             // literal `..` escapes /tmp ⇒ arm
    ['echo x >| src/a.ts', 'redirect into src/a.ts'],
    ['S=/tmp/a; cp "$S" src/x', 'cp src/x'],                                  // $S is the FIRST arg, not the target
    ['S=/tmp/b tee "$S"', 'tee $S'],              // prefix assignment: $S expands to the OLD value, same segment
    ['echo x > "$S"; S=/tmp/a', 'redirect into $S'],  // assignment AFTER the use — too late to resolve it
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
    'cargo install --list 2>/dev/null', 'npm install 2>&1 | tail -3',
    'echo hi > /tmp/x-$$.txt', 'echo hi > /tmp/janitor-$$-$RANDOM.txt',
    'S=/private/tmp/a/b.txt; echo x > "$S"',
    'O=/tmp/o.txt; { git log -3; } > "$O" 2>&1; cat "$O"',
    'S="/tmp/q.txt"; tee "$S" </dev/null',
    'cat /tmp/in > /tmp/out',
    'S=/tmp/a; cp src/x "$S"',
    'S=/tmp/a && echo x > "$S"',
    '(S=/tmp/a; echo x > "$S")',
  ]


  // The invariant is BOUNDARY equality, not count equality: `stripHeredocBodies(cmd, false)`
  // must always be an exact line-for-line PREFIX of `stripHeredocBodies(cmd, true)` (or equal to
  // it). Two different texts can share a segment COUNT while `cumulative[i]` means different
  // things to the two passes — that is the identical silent-release mechanism commit 1ade6293
  // fixed, and a count-only assertion would call such an input healthy. This checks the exported
  // production function DIRECTLY (no test-side reimplementation of the algorithm), so a
  // regression that breaks the shared-prefix guarantee is caught structurally, not by pinning one
  // instance of it.
  suite('review-gate triggers: heredoc pass agreement (class-level guard)', () => {
    function assertSharedPrefix(cmd: string, label: string): void {
      const closed = stripHeredocBodies(cmd, false)
      const open = stripHeredocBodies(cmd, true)
      assert.ok(
        open === closed || open.startsWith(closed + '\n'),
        `failOpen=false text is not a line-prefix of failOpen=true text for [${label}]\n` +
        `  closed: ${JSON.stringify(closed)}\n  open:   ${JSON.stringify(open)}`,
      )
    }

    const CASES: [string, string][] = [
      ['no heredoc at all', 'echo x > src/a.ts'],
      ['one terminated heredoc, then a write', 'cat <<EOF > /tmp/a\nbody\nEOF\ntouch src/x'],
      ['two terminated heredocs, then a write', 'cat <<A\nfoo\nA\ncat <<B\nbar\nB\ntouch src/y'],
      ['terminated heredoc body containing `;`', 'cat <<EOF\na ; b ; c\nEOF\ntouch src/z'],
      ['terminated heredoc body containing `|`', 'cat <<EOF\na | b\nEOF\ntouch src/w'],
      ['terminated heredoc body containing `&&`', 'cat <<EOF\na && b\nEOF\ntouch src/v'],
      ['terminated heredoc body containing `&`', 'cat <<EOF\na & b\nEOF\ntouch src/u'],
      ['an unterminated heredoc, real write past it still arms', 'cat <<A\ntouch src/t'],
      ['a terminated heredoc FOLLOWED by an unterminated one, write past it still arms',
        'cat <<A\nfoo\nA\ncat <<B\ngit commit -m x'],
      ['`<<` inside single quotes is not an operator', "echo '<<EOF' && git commit -m x"],
      ['`<<` inside double quotes is not an operator', 'echo "<<EOF" && git commit -m x'],
      ['bash -c wrapping a heredoc, then a write outside it', "bash -c 'cat <<EOF\nbody\nEOF' && touch src/s"],
      ['CRLF line endings around a terminated heredoc', 'cat <<EOF\r\nbody\r\nEOF\r\ntouch src/r'],
      ['a quoted delimiter, then a write', "cat <<'EOF'\nbody\nEOF\ntouch src/q"],
      ['a body containing `>` and `>=`, then a write', "cat <<'EOF'\na > b\na >= b\nEOF\ntouch src/p"],
      // Coordinator-requested case: a terminated heredoc body with exactly one `;` (one internal
      // separator) followed, after an UNTERMINATED second heredoc, by a tail whose own separator
      // count differs from the body's. Segment COUNTS for `open` vs `closed` here are NOT expected
      // to be equal (fail-open legitimately appends the tail) — the point of this case is that
      // `assertSharedPrefix` verifies the CORRECT relationship (prefix, not count) rather than
      // asserting raw counts and being unable to tell a real desync from an intentional extension.
      ['one `;` in a terminated body, then an unterminated heredoc whose tail has a different separator count',
        'cat <<A\nx ; y\nA\ncat <<B\ntouch src/n ; touch src/m ; touch src/o'],
    ]

    test('every case: failOpen=false is always a line-prefix of failOpen=true (boundary equality, not count equality)', () => {
      for (const [label, cmd] of CASES) assertSharedPrefix(cmd, label)
    })

    // Same corpus, verdict-level check: the shared prefix above is necessary but the caller
    // (`commandWriteReason`) must also reach the one correct answer built on top of it.
    const WANT: Record<string, string | null> = {
      'echo x > src/a.ts': 'redirect into src/a.ts',
      'cat <<EOF > /tmp/a\nbody\nEOF\ntouch src/x': 'touch src/x',
      'cat <<A\nfoo\nA\ncat <<B\nbar\nB\ntouch src/y': 'touch src/y',
      'cat <<EOF\na ; b ; c\nEOF\ntouch src/z': 'touch src/z',
      'cat <<EOF\na | b\nEOF\ntouch src/w': 'touch src/w',
      'cat <<EOF\na && b\nEOF\ntouch src/v': 'touch src/v',
      'cat <<EOF\na & b\nEOF\ntouch src/u': 'touch src/u',
      'cat <<A\ntouch src/t': 'touch src/t',
      'cat <<A\nfoo\nA\ncat <<B\ngit commit -m x': 'git commit',
      "echo '<<EOF' && git commit -m x": 'git commit',
      'echo "<<EOF" && git commit -m x': 'git commit',
      "bash -c 'cat <<EOF\nbody\nEOF' && touch src/s": 'touch src/s',
      'cat <<EOF\r\nbody\r\nEOF\r\ntouch src/r': 'touch src/r',
      "cat <<'EOF'\nbody\nEOF\ntouch src/q": 'touch src/q',
      "cat <<'EOF'\na > b\na >= b\nEOF\ntouch src/p": 'touch src/p',
      'cat <<A\nx ; y\nA\ncat <<B\ntouch src/n ; touch src/m ; touch src/o': 'touch src/n',
    }
    test('every case also reaches the one correct commandWriteReason verdict', () => {
      for (const [label, cmd] of CASES) assert.strictEqual(commandWriteReason(cmd, CWD), WANT[cmd], label)
    })
  })

  // STEP-3 regressions: both are variants of 1ade6293's bug shape that its own pinned test cannot
  // catch — one flips the assignment order (so a desync would arm spuriously instead of releasing
  // silently), the other removes the unterminated heredoc entirely (so any remaining divergence
  // must come from something OTHER than the failOpen/failClosed split this file's comments already
  // document as by-design).
  suite('review-gate triggers: segIdx desync additional regressions (pass-agreement)', () => {
    test('assignment order reversed: the LAST value (ephemeral) must release silently, not arm on the stale first value', () => {
      assert.strictEqual(
        commandWriteReason('S=/repo/real\ncat <<A\nx ; y ; z\nA\nS=/tmp/fake\ncat <<EOF > $S\nunterminated body\n', CWD),
        null,
      )
    })

    test('two TERMINATED heredocs and no unterminated one: a later $VAR redirect still resolves against the one real assignment', () => {
      assert.strictEqual(
        commandWriteReason('S=/repo/real\ncat <<A\nfoo\nA\ncat <<B\nbar\nB\necho x > $S', CWD),
        'redirect into $S',
      )
    })
  })


  suite("review-gate triggers: earlier terminated heredoc must not leak into a later unterminated one's fail-open text", () => {
    test("an EARLIER terminated heredoc's body, reinjected via failOpen=true, must not desync segIdx and release a stale $VAR redirect", () => {
      assert.strictEqual(
        commandWriteReason("S=/tmp/fake\ncat <<A\nx ; y ; z\nA\nS=/repo/real\ncat <<EOF > $S\nunterminated body\n", CWD),
        "redirect into $S",
      )
    })
  })


  suite("review-gate triggers: segIdx desync across the two heredoc passes (TRDD segidx desync)", () => {
    test("1a: git commit on the operator line, unterminated body containing separators, still arms as the commit", () => {
      assert.strictEqual(commandWriteReason("cat <<EOF && git commit -m x\nbody ; with | seps & more\n", CWD), "git commit")
    })

    test("1b: a same-line $VAR redirect before an unterminated heredoc body (with separators) still resolves and arms", () => {
      assert.strictEqual(commandWriteReason("OUT=/repo/f\ncat <<EOF > $OUT\nbody ; sep\n", CWD), "redirect into $OUT")
    })

    test("2a: a write-shaped phrase not in command position, inside an unterminated heredoc body, does not arm", () => {
      assert.strictEqual(commandWriteReason("cat <<EOF\nrun git commit -m x to finish\n", CWD), null)
    })

    test("2b: a TERMINATED heredoc body containing a write-shaped phrase is data, not commands", () => {
      assert.strictEqual(commandWriteReason("cat <<EOF > /tmp/s\nrun git commit -m x to finish\nEOF\n", CWD), null)
    })

    test("R: the 74b24905 regression pin — a >= comparison inside a quoted-delimiter heredoc body never arms", () => {
      assert.strictEqual(commandWriteReason("cat > /tmp/s <<'SPEC'\nreturn { block: a >= b }\nSPEC\n", CWD), null)
    })
  })

  suite('review-gate triggers: heredoc terminator matching is lenient, unterminated fails open for classification', () => {
    test('quoted delimiter (`<<\'EOF\'`) terminates and a later write still arms', () => {
      assert.strictEqual(commandWriteReason("cat <<'EOF' > /tmp/x\nEOF\ngit commit -m real", CWD), 'git commit')
    })

    test('a heredoc quoted inside `bash -c \'...\'` is not stripped by the outer pass', () => {
      assert.strictEqual(commandWriteReason("bash -c 'cat <<EOF\nbody\nEOF' && git commit -m x", CWD), 'git commit')
    })

    test('`<<` inside a quoted argument (not an operator) never starts a heredoc', () => {
      assert.strictEqual(commandWriteReason("grep '<<EOF' file && git commit -m x", CWD), 'git commit')
    })

    test('a terminator line with trailing whitespace still terminates', () => {
      assert.strictEqual(commandWriteReason('cat <<EOF\nbody\nEOF \ngit commit -m x', CWD), 'git commit')
    })

    test('a CRLF-terminated heredoc still terminates', () => {
      assert.strictEqual(commandWriteReason('cat <<EOF\r\nbody\r\nEOF\r\ngit commit -m x', CWD), 'git commit')
    })

    test('a genuinely unterminated heredoc with both a commit and a redirect-shaped line arms as the commit, not a redirect', () => {
      assert.strictEqual(commandWriteReason('cat <<EOF\ngit commit -m x\na >= b', CWD), 'git commit')
    })
  })


  suite('review-gate triggers: heredoc bodies are data, not shell words', () => {
    test('a heredoc BODY is not tokenized as shell words — the >= false positive of 2026-09-13', () => {
      // This exact document (a JS/TS snippet with `>=`) armed the gate as "redirect into =" before
      // the fix — the heredoc body was tokenized as shell words and `>=` matched the redirect regex.
      assert.strictEqual(
        commandWriteReason("cat > /tmp/spec.md <<'SPEC'\nreturn { block: Math.min(a, b) >= work.index }\nSPEC", CWD),
        null,
      )
    })

    test('a heredoc body containing shell-write-shaped text is data, not commands', () => {
      assert.strictEqual(commandWriteReason('cat <<EOF\ngit commit -m x\nrm -rf /etc\nEOF', CWD), null)
    })

    test('a same-line redirect before the heredoc operator still arms — the true positive', () => {
      assert.strictEqual(commandWriteReason('cat <<EOF > /proj/f.txt\nhello\nEOF', CWD), 'redirect into /proj/f.txt')
    })

    test('a same-line redirect into an ephemeral target does not arm', () => {
      assert.strictEqual(commandWriteReason("cat <<'EOF' > /tmp/x\nhello\nEOF", CWD), null)
    })

    test('two heredocs in one command are each stripped', () => {
      assert.strictEqual(commandWriteReason('cat <<A\nfoo\nA\ncat <<B\nbar\nB', CWD), null)
    })

    test('an unterminated heredoc fails OPEN for classification — a real git commit past it still arms', () => {
      assert.strictEqual(commandWriteReason('cat <<A\ngit commit -m x', CWD), 'git commit')
    })
  })

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
