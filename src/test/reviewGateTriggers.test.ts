import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  commandWriteReason, isEphemeralTarget, shellWords, textArms, PROPOSAL_MARKER,
  GIT_WRITE_SUBCOMMANDS, GH_MUTATING_VERBS, PKG_WRITE_VERBS, ALL_ARGS_ARE_TARGETS, LAST_ARG_IS_TARGET,
  scriptRunnerReason, isNeverGatedTarget, isNoReviewSentinel,
} from '../cli/reviewGateTriggers'
import { stripHeredocBodies } from '../cli/reviewGateTriggers'

// WHAT ARMS the review gate (TRDD-0E3W5C45). The ARM rows are the guard against the fail-OPEN
// direction (a write that goes unreviewed); the PASS rows guard the fail-CLOSED direction (the
// idle-turn livelock — every PASS row also passed the OLD gate, which armed Bash only on `git
// commit`). Both are needed: a gate that never arms is green on the PASS table alone.
// Paths use `/proj` and `/tmp` — a `/Users/<name>` fixture would trip check-identities.

const CWD = '/proj'

suite('review-gate triggers: a $VAR/suffix write target resolves through the recorded literal', () => {
  test('a redirect to $SP/f.py after SP=/tmp/x is scratch, not work', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > $SP/f.py', CWD), null)
  })

  test('a quoted "$SP/f.json" redirect after SP=/tmp/x is scratch, not work', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; q > "$SP/f.json"', CWD), null)
  })

  test('the braced ${SP}/f form after SP=/tmp/x is scratch, not work', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > ${SP}/f', CWD), null)
  })

  test('a "$SP"/f write after SP=/tmp/x is scratch: the quoted suffix still resolves to /tmp/x/f', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > "$SP"/f', CWD), null)
  })

  test('a $SP"/f" write after SP=/tmp/x is scratch: the shell joins the quoted suffix to /tmp/x/f', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > $SP"/f"', CWD), null)
  })

  test('a $SP/../../etc/f escape from the recorded /tmp/x still arms', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > $SP/../../etc/f', CWD), 'redirect into $SP/../../etc/f')
  })

  test('a $SP reassigned to a repo path before the write still arms', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; SP=src; cat > $SP/f', CWD), 'redirect into $SP/f')
  })

  test('an assignment in a segment that also runs a command records nothing, so $SP/f still arms', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x cat > $SP/f', CWD), 'redirect into $SP/f')
  })

  test('a $SP/$OTHER suffix (an expansion, not a literal) still arms', () => {
    assert.strictEqual(commandWriteReason('SP=/tmp/x; cat > $SP/$OTHER', CWD), 'redirect into $SP/$OTHER')
  })

  test('a $UNSET/f target with no recorded literal still arms', () => {
    assert.strictEqual(commandWriteReason('cat > $UNSET/f', CWD), 'redirect into $UNSET/f')
  })
})

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
    ['perl -lpi -e \'s/a/b/\' f', 'perl -i'],                  // a longer switch cluster still edits in place
    ['perl -wpi -e \'s/a/b/\' f', 'perl -i'],                  // -w (warnings) in the cluster still edits in place
    ['gh api --method=DELETE repos/a/b/git/refs/heads/x', 'gh api (mutating)'],  // attached pflag spelling
    ['gh api -XPOST repos/a/b/issues', 'gh api (mutating)'],
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
    ['S=/tmp/a; echo x > "$S/../../etc/x"', 'redirect into $S/../../etc/x'],  // $S/../.. resolves to /etc/x ⇒ arm
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
    'perl -Mstrict -e \'print 1\'',                                  // a leading long-option flag must not be misread as `-i`

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


    // Guards the actual shared invariant: BOTH passes tokenize with the SAME `shellWords`, and
    // `segIdx` is a counter over those TOKENIZED segments, not over the raw strip text. Text-prefix
    // (assertSharedPrefix above) only guarantees the real segIdx invariant if shellWords is
    // prefix-stable (tokenizing a prefix of the text yields a prefix of tokenizing the whole text).
    // That is nowhere else asserted, so a future shellWords change with lookahead/line-joining could
    // break the segIdx pairing while the text-prefix test stays green.
    function assertSharedPrefixSegments(cmd: string, label: string): void {
      const closedSegs = shellWords(stripHeredocBodies(cmd, false))
      const openSegs = shellWords(stripHeredocBodies(cmd, true))
      assert.deepStrictEqual(
        openSegs.slice(0, closedSegs.length), closedSegs,
        `failOpen=false tokenization is not an element-wise prefix of failOpen=true tokenization ` +
        `(breaks the segIdx pairing the two commandWriteReason passes share) for [${label}]\n` +
        `  closed: ${JSON.stringify(closedSegs)}\n  open:   ${JSON.stringify(openSegs)}`,
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


    test("every case: failOpen=false tokenization is an element-wise prefix of failOpen=true tokenization (the segIdx pair, not just the strip text)", () => {
      for (const [label, cmd] of CASES) assertSharedPrefixSegments(cmd, label)
    })

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
  test('a line starting with the marker (plain, bold, or a heading prefix) arms', () => {
    for (const t of [
      'PROPOSAL FOR ACTION - PLEASE REVIEW\nchange X',
      '**PROPOSAL FOR ACTION - PLEASE REVIEW**\nchange X',
      '## PROPOSAL FOR ACTION - PLEASE REVIEW\nchange X',
      'intro\n\nPROPOSAL FOR ACTION - PLEASE REVIEW\nlater line',
    ]) {
      assert.strictEqual(textArms(t), true, t)
    }
  })

  test('the dash between ACTION and PLEASE may be a hyphen, an en dash or an em dash', () => {
    for (const dash of ['-', '–', '—']) {
      assert.strictEqual(textArms(`PROPOSAL FOR ACTION ${dash} PLEASE REVIEW\nbody`), true, dash)
    }
  })

  test('the old PROPOSAL: marker no longer arms, and the new marker mid-sentence or quoted does not arm', () => {
    for (const t of [
      'PROPOSAL: change X', '**PROPOSAL:** change X',
      'janitor heartbeat', 'Holding.', 'I propose changing X to Y.', 'my proposal is X',
      '> PROPOSAL FOR ACTION - PLEASE REVIEW: quoted',
      'here:\n```ts\nconst x = 1\n```',
      'I wrote a PROPOSAL FOR ACTION - PLEASE REVIEW mid-sentence',
    ]) {
      assert.strictEqual(textArms(t), false, t)
    }
  })

  test('PROPOSAL_MARKER equals the literal string', () => {
    assert.strictEqual(PROPOSAL_MARKER, 'PROPOSAL FOR ACTION - PLEASE REVIEW')
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

// ── STAGE 1, D7: fastedit / trddgrep / prrdgrep / specgrep write verbs, deploy commands, and
// script-runner classification (plan test 19). Also covers checklist items (b)/(c): read-only
// tools used by this repo's own agents must stay null, and flags-before-subcommand shapes must
// still classify.
suite('review-loop D7: additional write-shaped verbs (fastedit/trddgrep/prrdgrep/specgrep/deploy)', () => {
  test('fastedit write verbs arm; fastedit read verbs do not', () => {
    for (const [cmd, why] of [
      ['fastedit edit f.ts --replace x --snippet y', 'fastedit edit'],
      ['fastedit multi-edit --file-edits x', 'fastedit multi-edit'],
      ['fastedit create f.ts --content x', 'fastedit create'],
      ['fastedit rename f.ts old new', 'fastedit rename'],
      ['fastedit undo f.ts', 'fastedit undo'],
    ] as [string, string][]) {
      assert.strictEqual(commandWriteReason(cmd, CWD), why, cmd)
    }
    for (const cmd of ['fastedit read f.ts', 'fastedit search x dir', 'fastedit diff f.ts']) {
      assert.strictEqual(commandWriteReason(cmd, CWD), null, cmd)
    }
  })

  test('fastedit duplicate with an ephemeral SOURCE still arms: the write lands in the destination', () => {
    assert.strictEqual(commandWriteReason('fastedit duplicate /tmp/a.md src/b.md', CWD), 'fastedit duplicate')
  })

  test('fastedit join with an ephemeral parts DIRECTORY still arms: the write lands in the -o target', () => {
    assert.strictEqual(commandWriteReason('fastedit join /tmp/parts -o src/x.md', CWD), 'fastedit join')
  })

  test('fastedit split with an ephemeral SOURCE still arms: the parts are written under --out', () => {
    assert.strictEqual(commandWriteReason('fastedit split /tmp/big.md --out src/', CWD), 'fastedit split')
  })

  test('a fastedit write into reports/ or /tmp is scratch, not work', () => {
    assert.strictEqual(commandWriteReason('fastedit create /tmp/a.md', CWD), null)
    assert.strictEqual(commandWriteReason('fastedit create reports/x.md', CWD), null)
  })

  test('a fastedit write into src still arms', () => {
    assert.strictEqual(commandWriteReason('fastedit edit src/a.ts --replace f', CWD), 'fastedit edit')
  })

  test('a flag-first `fastedit edit --replace x /tmp/a.md` stays armed (fail closed: its first non-flag word is `x`, not the /tmp file)', () => {
    assert.strictEqual(commandWriteReason('fastedit edit --replace x /tmp/a.md', CWD), 'fastedit edit')
  })

  test('a flag value that looks like /tmp does not stand in for the file (fail closed)', () => {
    assert.strictEqual(commandWriteReason('fastedit create --content-file /tmp/c.txt src/new.ts', CWD), 'fastedit create')
  })

  // TRDD-J2K6IM4R: a standalone -h/--help on a fastedit/memgrep write verb never runs the
  // handler (argparse/clap print help and exit first), so it must NOT arm; a --help that could
  // be an option's VALUE (preceded by another "-" token), one past a bare `--`, or embedded in a
  // larger/quoted token must still arm — that shape is a real write the parser will execute.
  test('a standalone -h/--help exempts fastedit/memgrep write verbs; anything else still arms', () => {
    for (const cmd of [
      'fastedit --help',
      'fastedit multi-edit --help',
      'fastedit delete f.ts --help',
      'fastedit edit f.ts -h --replace x',
      'memgrep new-mem-atom --help',
    ]) {
      assert.strictEqual(commandWriteReason(cmd, CWD), null, cmd)
    }
    for (const [cmd, why] of [
      ["fastedit edit f.ts --replace x --snippet 'a --help b'", 'fastedit edit'],
      ["fastedit edit f.ts --replace x --snippet s -- --help", 'fastedit edit'],
      ['fastedit edit f.ts --dry-run --help', 'fastedit edit'],
      ['fastedit edit f.ts --snippet=--help', 'fastedit edit'],
      ['fastedit --help && fastedit edit f.ts --replace x --snippet s', 'fastedit edit'],
      ['fastedit edit f.ts --help > notes.md', 'redirect into notes.md'],
      ["fastedit edit f.ts --replace x --snippet \"$(cat s --help)\"", 'fastedit edit'],
    ] as [string, string][]) {
      assert.strictEqual(commandWriteReason(cmd, CWD), why, cmd)
    }
  })

  test('trddgrep write verbs arm (including index-verify --repair); read verbs (incl. `show`) do not', () => {
    assert.strictEqual(commandWriteReason('trddgrep new --title X --task-type feature', CWD), 'trddgrep new')
    assert.strictEqual(commandWriteReason('trddgrep set TRDD-1 column dev', CWD), 'trddgrep set')
    assert.strictEqual(commandWriteReason('trddgrep index-verify --repair', CWD), 'trddgrep index-verify --repair')
    assert.strictEqual(commandWriteReason('trddgrep index-verify', CWD), null)
    assert.strictEqual(commandWriteReason('trddgrep show TRDD-1', CWD), null)
    assert.strictEqual(commandWriteReason('trddgrep --design-dir /proj/design set TRDD-1 column dev', CWD), 'trddgrep set') // (c): flag before subcommand
  })

  test('prrdgrep/specgrep edit arms; other verbs do not', () => {
    assert.strictEqual(commandWriteReason('prrdgrep edit 1 --expect x --replace y', CWD), 'prrdgrep edit')
    assert.strictEqual(commandWriteReason('specgrep edit 1 --expect x --replace y', CWD), 'specgrep edit')
    assert.strictEqual(commandWriteReason('prrdgrep lint', CWD), null)
    assert.strictEqual(commandWriteReason('AIM_PILLAR_ALLOW_WRITE=1 trddgrep --design-dir /proj/design edit 1 --expect x --replace y', CWD), 'trddgrep edit') // (c)
  })

  test('deploy commands arm, with flags before the subcommand still detected (checklist c)', () => {
    assert.strictEqual(commandWriteReason('node esbuild.js', CWD), 'node esbuild.js')
    assert.strictEqual(commandWriteReason('node ./esbuild.js', CWD), 'node esbuild.js')
    assert.strictEqual(commandWriteReason('node /abs/esbuild.js', CWD), 'node esbuild.js') // (c): basename match, any path
    assert.strictEqual(commandWriteReason('pnpm run package', CWD), 'pnpm run package')
    assert.strictEqual(commandWriteReason('pnpm --dir /repo run package', CWD), 'pnpm run package')
    assert.strictEqual(commandWriteReason('npm --prefix /repo run compile', CWD), 'npm run compile') // (c): --prefix skipped
    assert.strictEqual(commandWriteReason('agentlenspro server restart', CWD), 'agentlenspro server restart')
    assert.strictEqual(commandWriteReason('agentlenspro server status', CWD), null) // (b): read-only
    assert.strictEqual(commandWriteReason('pnpm run lint', CWD), null) // lint isn't in the deploy list
  })

  test('script runners need a window; a plugin-cache/data script is exempt; inline code never is', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlt-'))
    // (h): the implementation resolves `~/.claude/plugins/{cache,data}` via `os.homedir()`, which
    // reads `HOME` at call time — override HOME for this test's scope instead of writing fixtures
    // into the REAL ~/.claude/plugins. Restored in `finally`, whatever happens.
    const realHome = process.env.HOME
    process.env.HOME = tmp
    try {
      assert.strictEqual(scriptRunnerReason('uv run /tmp/x.py', tmp), 'uv (script runner)')
      assert.strictEqual(scriptRunnerReason('node ./x.js', tmp), 'node (script runner)')
      assert.strictEqual(scriptRunnerReason('pnpm run build', tmp), 'pnpm (script runner)')
      assert.strictEqual(scriptRunnerReason('cargo test', tmp), 'cargo (script runner)')
      assert.strictEqual(scriptRunnerReason('git status', tmp), null) // not a runner at all
      assert.strictEqual(scriptRunnerReason('python -c "print(1)"', tmp), 'python (inline code)')
      assert.strictEqual(scriptRunnerReason('python3.11 -c "1"', tmp), 'python3.11 (inline code)')

      const pluginData = path.join(tmp, '.claude', 'plugins', 'data', 'ai-maestro-janitor-ai-maestro-plugins')
      fs.mkdirSync(pluginData, { recursive: true })
      const stub = path.join(pluginData, 'dispatcher-stub.py')
      fs.writeFileSync(stub, '# stub\n')
      assert.strictEqual(scriptRunnerReason(`uv run --script --quiet "${stub}" 2>&1`, tmp), null) // (b): exempt, PASS
      const outside = path.join(tmp, 'x.py')
      fs.writeFileSync(outside, '# not a plugin script\n')
      assert.strictEqual(scriptRunnerReason(`python3 ${outside}`, tmp), 'python3 (script runner)') // NOT exempt
    } finally {
      process.env.HOME = realHome
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // MUTATION CHECK 19: disable the deploy-verb classification (comment out its call site) and
  // confirm 'node esbuild.js' goes from armed to unarmed, then restore and confirm it re-arms.
  // (This test documents the check performed manually via fastedit during development — see the
  // STAGE 1 report for the disable/restore transcript; the assertion below is the "confirm green"
  // half and is what CI actually runs on every commit.)
  test('mutation-check anchor: node esbuild.js must arm (guards against the deploy-verb branch silently no-op-ing)', () => {
    assert.strictEqual(commandWriteReason('node esbuild.js', CWD), 'node esbuild.js')
  })
})

suite('review-loop D3: isNeverGatedTarget (moved from delegateGate.ts, behaviour unchanged)', () => {
  test('ephemeral roots and ~/.claude/plans/ are never gated; everything else is decided normally', () => {
    const plansFile = path.join(os.homedir(), '.claude', 'plans', 'x.md')
    assert.strictEqual(isNeverGatedTarget('/tmp/x', CWD), true)
    assert.strictEqual(isNeverGatedTarget('reports/x', CWD), true)
    assert.strictEqual(isNeverGatedTarget(plansFile, CWD), true)
    assert.strictEqual(isNeverGatedTarget('src/x.ts', CWD), false)
    assert.strictEqual(isNeverGatedTarget('', CWD), false)
  })
})

suite('review-loop: isNoReviewSentinel (moved from reviewGate.ts, behaviour unchanged)', () => {
  test('a sentinel with a real reason releases; a bare or reasonless one does not', () => {
    assert.strictEqual(isNoReviewSentinel('REVIEW-GATE: NO REVIEW POSSIBLE — rate-limited'), true)
    assert.strictEqual(isNoReviewSentinel('REVIEW-GATE: NO REVIEW POSSIBLE'), false)
    assert.strictEqual(isNoReviewSentinel('REVIEW-GATE: NO REVIEW POSSIBLE — ab'), false)
    assert.strictEqual(isNoReviewSentinel('prose quoting REVIEW-GATE: NO REVIEW POSSIBLE — rate-limited'), false)
  })
})
