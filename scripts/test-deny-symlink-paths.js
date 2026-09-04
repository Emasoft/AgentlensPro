#!/usr/bin/env node
// Matrix for scripts/deny-symlink-paths.js. Real dirs, real symlinks — the guard's whole job is a
// filesystem judgement, so a mocked fs would test nothing.
//
// The load-bearing halves: an agent-created symlink in a NAMED path is stopped once with an OTP,
// and the platform's own symlinks (/tmp, homebrew) are NOT — a guard that demanded a password for
// every command touching /tmp would be switched off within the hour.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-symlink-paths.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symguard-'))
const real = path.join(root, 'real')
const link = path.join(root, 'linked')
const deep = path.join(link, 'a', 'b')
fs.mkdirSync(path.join(real, 'a', 'b'), { recursive: true })
fs.symlinkSync(real, link)
fs.writeFileSync(path.join(real, 'file.txt'), 'x')

const run = (command) => {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd: root }), encoding: 'utf8',
  })
  return { denied: out.includes('"deny"'), otp: (/SYMLINK_OTP=([0-9A-F]{8})/.exec(out) || [])[1], out }
}
// Same, but with the HOOK process deliberately running somewhere other than the session cwd. That
// is the normal case in a worktree or after an --add-dir, and it is what makes `$PWD` ambiguous:
// the hook's own environment answers a question that is about the COMMAND's directory.
const runFromElsewhere = (command) => {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd: root }),
    encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, PWD: os.tmpdir() },
  })
  return { denied: out.includes('"deny"') }
}

let failed = 0
const check = (ok, desc) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`) }

// --- the point of the guard -------------------------------------------------------------------
check(run(`cp x ${link}`).denied, 'a named symlink is stopped')
check(run(`cp ${deep}/../file.txt y`).denied, 'a symlink as an ANCESTOR of the named path is stopped')
check(run(`rm -rf ${link}/a`).denied, 'the destructive shape that motivated this is stopped')
check(!run(`cp x ${real}`).denied, 'the real path behind the link is allowed')
check(!run('echo hello').denied, 'a command with no path is allowed')
check(!run('git status').denied, 'an ordinary command is allowed')

// --- READ-ONLY commands are exempt, but only when the INVOCATION is read-only ---------------
check(!run(`ls ${link}`).denied, 'ls through a symlink reads nothing destructive: exempt')
check(!run(`cat ${link}/file.txt`).denied, 'cat is exempt')
check(!run(`find ${link} -name x`).denied, 'find is exempt')
check(!run(`grep -r foo ${link}`).denied, 'grep is exempt')
// ...and the exemption must NOT survive a redirect or a mutating flag, or it is a hole an agent
// walks through by accident.
check(run(`cat ${link}/file.txt > out.txt`).denied, 'a redirect makes a read-only command WRITE')
check(run(`ls ${link} >> log`).denied, 'append redirect too')
check(run(`find ${link} -delete`).denied, 'find -delete mutates')
check(run(`find ${link} -exec rm {} ;`).denied, 'find -exec mutates')
check(run(`cp x ${link} && ls ${link}`).denied, 'a mixed line is judged per segment, not as a whole')
// The case above passes under BOTH per-segment and judge-by-first-word, so it pins nothing. This
// one distinguishes them: read-only FIRST, mutating second. First-word judgement would allow it.
check(run(`ls ${link} && cp x ${link}`).denied, 'read-only first, mutating second: still denied')
check(run(`awk '{system("rm " $0)}' ${link}/f`).denied, 'awk is a language with system(), not a read-only filter')

// PIPING re-arms the exemption. A read-only command is harmless only if its OUTPUT goes nowhere
// dangerous — `ls <symlink> | oppa` reads through the link and hands the result to an unknown
// binary. Judging stages independently allowed exactly this.
check(run(`ls ${link} | oppa`).denied, 'read-only piped into an UNKNOWN binary re-arms the guard')
check(run(`cat ${link}/f | xargs rm`).denied, 'cat piped into xargs rm')
check(!run(`ls ${link} | grep foo`).denied, 'a pipeline of ALL-known-read-only stages stays exempt')
check(!run(`cat ${link}/f | head -5 | wc -l`).denied, 'three read-only stages stay exempt')

// A quoted `|` is DATA. Splitting on it invented a stage whose command word was `b"` — unknown, so
// the pipeline re-armed and a plain grep was denied.
check(!run(`grep "a|b" ${link}/f`).denied, 'a | inside a quoted pattern is not a pipe')

// LONG-FORM mutating flags. `-o` alone missed `sort --output=`, which writes — a mutating
// invocation classified read-only, i.e. a bypass (found by security review 2026-09-03).
check(run(`sort --output=${link}/o ${link}/i`).denied, 'sort --output= writes, like -o')
check(run(`find ${link} -execdir rm {} +`).denied, 'find -execdir mutates')

// An UNKNOWN binary is the common real shape — a project script, a tool the guard has never heard
// of. It is caught by being absent from READONLY, with or without a pipe.
check(run(`oppa ${link}/f`).denied, 'an unknown binary with a symlink arg is denied')
check(run(`oppa ${link}`).denied, '...symlink as the FINAL component too')

// OFFSET ALIGNMENT. Stage content is sliced from the ORIGINAL text by offset, so every mask applied
// before splitting MUST preserve length. Collapsing `2>&1` to one space shifted everything after
// it and the misaligned stage's paths were never extracted — a MISS, not friction: any command with
// a redirect before the dangerous one went unchecked.
check(run(`cp a b 2>&1 ; cp x ${link}`).denied, 'a fd-dup BEFORE the dangerous command must not shift offsets')
check(run(`ls ${link} 2>&1 | oppa`).denied, 'fd-dup inside a pipeline into an unknown binary')
check(run(`cp x ${link} ; cp x ${link}`).denied, 'two identical pipelines: indexOf must not mis-slice')
check(run(`./scripts/ci.sh ${link}`).denied, 'a project script is denied')

// The flag letters mean OPPOSITE things per command, and a global list denied the two most common
// read-only invocations an agent runs. Measured 2026-09-03; pinned so it cannot regress.
check(!run(`grep -i foo ${link}/f`).denied, 'grep -i is IGNORE-CASE, not in-place')
check(!run(`diff -i ${link}/a ${link}/b`).denied, 'diff -i is ignore-case too')
check(!run(`ls ${link} 2>&1`).denied, '2>&1 merges stderr and creates nothing')
check(!run(`grep "a > b" ${link}/f`).denied, 'a > inside a quoted ARGUMENT is data, not a redirect')
// A RELATIVE token that does not exist is not a path the command means. Walking up from it reaches
// the HOOK's cwd ancestors, so on a machine whose project sits under a symlinked path this would
// deny every command carrying a quoted slash-containing string.
check(!run(`grep "src/foo bar" ${real}/f`).denied, 'a nonexistent RELATIVE token is not a path candidate')

// THE ORIGINATING INCIDENT'S SHAPE. This guard shipped with no cd tracking, so a relative path
// after a `cd` resolved against the HOOK's cwd — and if a same-named directory happened to exist
// there (`node_modules` in the repo root, which it does) the guard confirmed a path the command
// never touched and ALLOWED. Deferred four turns while patching around it.
const wtDir = path.join(root, 'wt')
fs.mkdirSync(wtDir, { recursive: true })
fs.symlinkSync(real, path.join(wtDir, 'node_modules'))
check(run(`cd ${wtDir} && cp x node_modules/`).denied, 'cd then a RELATIVE symlinked path: the incident shape')
check(run(`pushd ${wtDir} && mv a node_modules/b`).denied, 'pushd form')
check(run(`cd ${wtDir} ; cp x node_modules/`).denied, 'cd carried across ; into a later pipeline')
check(run(`cd ${wtDir} && cp x ./node_modules/notyet`).denied, 'a symlinked ANCESTOR counts even when the leaf does not exist yet')
check(!run(`cd ${wtDir} && ls node_modules/`).denied, 'read-only after a cd is still exempt')
// A cd reaches the NEXT command only when the separator means "it ran and we are still in that
// shell". `||` runs its right side only if the cd FAILED; `&` backgrounds it in a subshell; every
// stage of a `|` pipeline is its own subshell. Carrying the dir across those made the guard DENY
// while naming a path the command cannot reach — a verdict about the wrong file, not friction.
check(!run(`cd ${wtDir} || cp x node_modules/`).denied, '|| : the cd did NOT run, so it sets no base')
check(!run(`cd ${wtDir} & cp x node_modules/`).denied, '& : the cd is backgrounded in a subshell')
check(!run(`cd ${wtDir} | cp x node_modules/`).denied, '| : each pipeline stage is its own subshell')
check(run(`cd ${wtDir} && cp x node_modules/ | cat`).denied, '...but a cd BEFORE the pipeline still reaches it')
check(run(`cd ${wtDir} && cat f | cp x node_modules/`).denied, '...and reaches a LATER stage, not just the first')
// `(` is a boundary. Without this the paren form ALLOWED while the brace form denied — the brace
// only ever worked because `{` happens to be followed by a space, which is not a design.
check(run(`(cd ${wtDir} && cp x node_modules/)`).denied, 'a subshell in parens is still the incident shape')
// The one case that distinguishes an explicit cd from a CHANGED dir. `cd .` changes nothing, so a
// guard inferring "a cd occurred" from `dir !== sessionCwd` gates this relative nonexistent leaf
// away and ALLOWS — which is why effectiveCwd reports `matched` instead of the caller guessing.
check(run(`cd . && cp x linked/notyet`).denied, 'cd . is an explicit cd even though the dir is unchanged')
// ...and its complement, which is what stops `matched` from being hardcoded true: with NO cd, a
// relative leaf that does not exist is gated away instead of resolved.
check(!run(`cp x linked/notyet`).denied, 'no cd: a nonexistent relative leaf stays gated')
// A no-op prefix must not defeat the guard. `cd $PWD` used to resolve to `<cwd>/$PWD` — fictional —
// and then wave the relative path past the existence gate, so the real symlink was never examined.
check(run(`cd $PWD && cp x ${path.basename(link)}/f`).denied, 'cd $PWD does not redirect the search into a fictional dir')
check(run(`cd \${PWD} && cp x ${path.basename(link)}/f`).denied, '...brace form too')
// An unexpandable target leaves the base where it was rather than inventing `<cwd>/$NOPE`. It does
// NOT claim `matched`, so a nonexistent leaf still gets gated — we do not know where that cd went,
// and guessing a directory is how the $PWD bypass worked.
check(run(`cd $NOPE_UNSET && cp x ${path.basename(link)}/`).denied, 'an unexpandable cd target leaves the base where it was')
check(!run(`cd $NOPE_UNSET && cp x ${path.basename(link)}/notyet`).denied, '...and claims no explicit base, so a nonexistent leaf stays gated')
// DOCUMENTS AN ACCEPTED MISS, and pins nothing: `cd *` lands wherever the shell's glob lands, so
// `cd * && cp x <symlink>/` is not caught. Treating the glob as unresolvable stops the guard
// INVENTING `<cwd>/*` as a base, but that is a narrowing with no observable verdict change — the
// gate skips the nonexistent leaf either way. Resolving it would mean running the glob.
check(!run(`cd * && cp x ${path.basename(link)}/notyet`).denied, 'a glob is a directory only the shell knows')
// A cd inside a command substitution runs in a subshell. Segmentation splits on the `&&` INSIDE
// it, so effectiveCwd sees a torn `echo $( cd x ` whose cd looks top-level — prefixing that to any
// command moved the base and hid the real symlink. All three spellings, because the first fix was
// a lookbehind on `(` and one space walked straight past it.
const sub = path.join(root, 'elsewhere')
fs.mkdirSync(sub, { recursive: true })
check(run(`cp x ${path.basename(link)}/`).denied, 'baseline for the substitution cases')
check(run(`echo $( cd ${sub} && pwd ) && cp x ${path.basename(link)}/`).denied, 'a spaced $( cd … ) prefix does not move the base')
check(run(`echo $(cd ${sub} && pwd) && cp x ${path.basename(link)}/`).denied, '...nor an unspaced one')
check(run('echo `cd ' + sub + ' && pwd` && cp x ' + path.basename(link) + '/').denied, '...nor a backtick one')
// Correct for the RIGHT reason: the cp is inside the same subshell as the cd, so the cd really
// does apply to it. A `( … )` subshell does NOT move the parent — same as `$( … )` — so the case
// just below, where the cp is OUTSIDE, is deliberate OVER-RESOLUTION and not a semantic claim.
check(run(`(cd ${wtDir} && cp x node_modules/)`).denied, 'a subshell cd applies to commands INSIDE the same subshell')
// Nesting puts the inner `)` in the OPENER's part, so the cd lands in a part with no opener and
// reads as top-level. Per-part blanking cannot see two parts back; only depth counted across parts
// can. This is the shape blanking alone missed.
// `sub` gets a REAL directory of the same name, so the two bases give opposite verdicts: resolved
// against root, `linked/` is a symlink and denies; against sub it is an ordinary dir and allows.
// That pins the base itself. Naming a nonexistent leaf would NOT work — with the cd correctly
// skipped there is no explicit base, so the existence gate drops it and the case allows for a
// reason that has nothing to do with nesting.
// MUST stay after the three substitution checks above — they need `sub/linked` ABSENT.
fs.mkdirSync(path.join(sub, path.basename(link)), { recursive: true })
check(run(`echo $( echo $(date) && cd ${sub} ) && cp x ${path.basename(link)}/`).denied, 'a NESTED substitution does not let its cd escape')
// Depth counts SYNTAX, so a paren inside a quoted argument is not an opener. Counting it left the
// counter stuck open and skipped every later cd — the same class as the nesting bug, mirrored.
check(run(`grep '$(' f && cd ${wtDir} && cp x node_modules/`).denied, "a quoted $( is an argument, not a substitution opener")
// NOT a pin on the masked-count fix — under that mutation the lone `)` clamps to 0 and the cd is
// still tracked. It is a regression guard for a future change that removes the clamp.
check(run(`grep 'a)' f && cd ${wtDir} && cp x node_modules/`).denied, '...and a quoted ) is not a closer')
// The quote mask needs a CLOSING quote, so an unbalanced one masks nothing and the depth counter
// sees a quoted `$(` as a real opener — sticking open and skipping every later cd.
check(run(`echo "$( && cd ${wtDir} && cp x node_modules/`).denied, 'an unbalanced double quote does not disable cd tracking')
check(run(`echo '$( && cd ${wtDir} && cp x node_modules/`).denied, '...nor an unbalanced single quote')
// NOT a pin on the leftover-quote check — the mask blanks this span, so it denies with or without
// it. A mask regression guard, like `grep 'a)'` above.
check(run(`echo "$( x " && cd ${wtDir} && cp x node_modules/`).denied, '...and a BALANCED quoted $( is still just an argument')
// An apostrophe is not a broken quote to the DEPTH counter, and treating it as one vetoed the gate
// for the whole command line — re-opening the nesting bypass behind `echo it's` or `-m "don't"`.
check(run(`echo it's $( echo $(date) && cd ${sub} ) && cp x ${path.basename(link)}/`).denied, "an apostrophe does not disable the nesting defence")
check(run(`git commit -m "don't" && echo $( echo $(date) && cd ${sub} ) && cp x ${path.basename(link)}/`).denied, '...nor a contraction inside a balanced quote')
// `)` is shell syntax, so it must not be swallowed into a cd target: `cd <dir> )` took the paren
// as part of the name and resolved against the fictional `<dir> )`.
check(run(`(cd ${wtDir} ) && cp x node_modules/`).denied, 'a trailing ) is not part of the directory name')
// ...and it must TERMINATE the target, not merely be excluded from it: with no space the class
// stops at `)`, the trailing context could not match there, and the whole regex found no cd at all.
// `(cd dir)` with no inner space is how most people write a one-shot subshell.
// DELIBERATE OVER-RESOLUTION, recorded so nobody "corrects" it: the cp runs in the PARENT, where
// the subshell's cd never applied, so this DENY names a path the command does not reach. Accepted
// because the alternative — not matching at all — was the shape that let `(cd <wt>) && cp x
// node_modules/` through entirely, and an extra OTP prompt is the cheaper error.
check(run(`(cd ${wtDir}) && cp x node_modules/`).denied, 'a ) with no space before it still ends the target')
// A name that really contains parens must survive the terminator: stopping at the `)` yields
// `<base>/a(b`, which does not exist, and claiming it would disable the existence gate.
const pdir = path.join(root, 'a(b)', 'sub')
fs.mkdirSync(pdir, { recursive: true })
fs.symlinkSync(real, path.join(pdir, 'node_modules'))
check(run(`cd ${pdir} && cp x node_modules/`).denied, 'an UNQUOTED directory name containing parens is not truncated')
// Glob AND paren together: the only shape that reaches the `)`-repair's early return, so neither
// the main bailout nor the general rule at the end of the function ever sees it. That is the path
// a deletion justified as "same predicate, one line later" did not account for.
const gdir = path.join(root, 'a*b(c)', 'sub')
fs.mkdirSync(gdir, { recursive: true })
check(run(`cd ${root}/a*b(c)/sub && cp x ${path.basename(link)}/`).denied, 'a glob-bearing target claims no base, even when the literal spelling exists')
// The glob AFTER the paren, so the truncated `expanded` carries none and only the repair's own
// copy of the bailout list can catch it. Two gates, and this is the one that isolates the second:
// without it the repair returns matched:true on a literal name the shell would have globbed.
const gdir2 = path.join(root, 'a(b)*x', 'sub')
fs.mkdirSync(gdir2, { recursive: true })
check(run(`cd ${root}/a(b)*x/sub && cp x ${path.basename(link)}/`).denied, '...including a glob that only survives in the whole-word spelling')
// No paren, so the repair never runs: an unquoted glob whose literal spelling is ABSENT must leave
// the base alone. (This does NOT isolate the main gate — the general existence rule at the end of
// effectiveCwd refuses the same input. That redundancy is deliberate and recorded there.)
check(run(`cd ${root}/a*b-nomatch/sub && cp x ${path.basename(link)}/`).denied, 'an unquoted glob with no literal match claims no base')
// A glob character in a name that REALLY EXISTS is a name: with nullglob off the shell passes an
// unmatched pattern through literally, so refusing here would throw away a base we can resolve.
const litglob = path.join(root, 'rel-1.0[stable]')
fs.mkdirSync(litglob, { recursive: true })
fs.symlinkSync(real, path.join(litglob, 'node_modules'))
check(run(`cd ${litglob} && cp x node_modules/`).denied, 'a literal glob-char directory that exists is still tracked')
// One shell WORD, quoting changing mid-token: the whole-word scan stops at the quote and would
// otherwise claim the shallower prefix as the base.
// Asserting DENY, not ALLOW: claiming the shallower `<root>/a(b)` as the base is what HIDES the
// symlink at the real cwd, so only a DENY-side case discriminates.
check(run(`cd ${root}/a(b)'*'/sub && cp x ${path.basename(link)}/`).denied, 'a token cut short by a quote claims no base')
// Both spellings must go through the SAME expansion: the truncated one had `$PWD` substituted and
// the whole-word one did not, so the correct `<cwd>/a(b)` was never built out of the two halves.
check(run(`cd $PWD/a(b)/sub && cp x node_modules/`).denied, 'a $PWD prefix and a paren name are fixed together, not separately')
// `$PWD` means the COMMAND's directory. Resolving it from the hook's own environment answered a
// different question and lost the symlink entirely — in the ARGUMENT position, not just after a cd.
check(runFromElsewhere(`cp x ${path.basename(link)}/`).denied, 'control: a relative arg still resolves against the session cwd')
check(runFromElsewhere(`cp x $PWD/${path.basename(link)}/`).denied, '$PWD in an argument is the session cwd, not the hook process cwd')
// A variable the COMMAND assigns makes our inherited copy stale. Reading ours claimed a base the
// command never used — and claiming ANY base disables the existence gate downstream.
process.env.SYMGUARD_STALE = path.join(root, 'elsewhere')
check(run(`SYMGUARD_STALE=${wtDir} && cd $SYMGUARD_STALE && cp x ${path.basename(link)}/`).denied, 'a variable the command reassigns is not read from our environment')
// And the rule those bypasses all reduced to: never claim a base that does not exist, because that
// claim is what turns the gate off.
check(!run(`cd ${root}/does-not-exist && cp x ${path.basename(link)}/notyet`).denied, 'a nonexistent cd target claims nothing')
check(run(`cd ${root}/does-not-exist && cp x ${path.basename(link)}/`).denied, '...so the REAL cwd is still checked')
// The conservative half. Asserting DENY, not ALLOW: an allow-side assertion here is vacuous —
// both the right answer and the fictional base produce "no symlink found". Claiming nothing leaves
// the base at the real cwd, where `linked/` IS a symlink; claiming the fictional base hides it.
check(run(`cd ${root}/nope(x)/deeper && cp x ${path.basename(link)}/`).denied, 'neither spelling exists: claim nothing, so the REAL cwd is still checked')
// ...but INSIDE quotes a paren is a name, and excluding it everywhere left the closing quote
// unreachable, so the regex matched nothing and no cd was seen at all. `Screenshot (1)` is routine.
const paren = path.join(root, 'My Docs (2026)')
fs.mkdirSync(paren, { recursive: true })
fs.symlinkSync(real, path.join(paren, 'node_modules'))
check(run(`cd 'My Docs (2026)' && cp x node_modules/`).denied, 'a QUOTED directory name may contain parentheses')
// The alternate base is checked only while the base is IN DOUBT. Here the substitution CLOSES, so
// the cd is known not to apply and naming `<wt>/node_modules` would be a verdict about a file this
// command cannot reach. The unclosed form above it must still deny — that is the case it exists for.
check(!run(`echo $( grep "a && cd ${wtDir} ) && cp x node_modules/`).denied, 'a closed substitution ends the doubt: no stale alternate base')
check(run(`echo $( grep "a && cd ${wtDir} && cp x node_modules/`).denied, '...while an UNCLOSED one keeps it')
// A glob char in a name that REALLY EXISTS is a name, not a pattern. A blanket character test
// stopped tracking these, trading a real regression for a `cd *` improvement worth nothing.
const bracket = path.join(root, 'My Docs [2026]')
fs.mkdirSync(bracket, { recursive: true })
fs.symlinkSync(real, path.join(bracket, 'node_modules'))
check(run(`cd 'My Docs [2026]' && cp x node_modules/`).denied, 'a directory whose real name contains glob chars is still tracked')
check(run(`sort -o ${link}/out ${link}/in`).denied, 'sort -o DOES write in place')
check(run(`sed -i s/a/b/ ${link}/f`).denied, 'sed is not read-only at all')

// --- paths with SPACES. Routine on macOS; all three spellings silently bypassed the guard until
// --- quoted segments were extracted whole (measured 2026-09-03).
const spaced = path.join(root, 'My Project')
fs.symlinkSync(real, spaced)
check(run(`cp "${spaced}/x" y`).denied, 'double-quoted spaced path')
check(run(`cp '${spaced}/x' y`).denied, 'single-quoted spaced path')
check(run(`cp ${spaced.replace(' ', '\\ ')}/x y`).denied, 'backslash-escaped spaced path')

// --- the exclusions: platform symlinks must NOT cost an OTP -----------------------------------
// AND their SUBTREES must still be inspected. Listing /tmp and /var as PREFIXES excluded every
// scratch dir and worktree — including the incident path — and the matrix only noticed because its
// fixture happens to live in a temp dir. This case makes that explicit instead of accidental.
// The owner's own example, on a LITERAL /tmp path — not under mkdtemp, so it cannot pass by an
// accident of where fixtures happen to live: "/tmp is a known symlink, so it's ignored. but if
// after tmp there is a non whitelisted symlink folder (i.e. /tmp/this-is-a-symlink/) then it must
// trigger the protection."
const litReal = `/tmp/symguard-real-${process.pid}`
const litLink = `/tmp/symguard-link-${process.pid}`
fs.mkdirSync(path.join(litReal, 'sub'), { recursive: true })
fs.symlinkSync(litReal, litLink)
check(run(`cp x ${litLink}/`).denied, 'a symlink COMPONENT under /tmp triggers, though /tmp itself does not')
check(run(`mv ${litLink}/sub/f.txt z`).denied, '...at any depth beneath it')
check(!run(`cp x ${litReal}/sub`).denied, 'a real path under /tmp stays allowed')
fs.unlinkSync(litLink); fs.rmSync(litReal, { recursive: true, force: true })

const tmpLink = path.join(os.tmpdir(), `symguard-probe-${process.pid}`)
try { fs.symlinkSync(real, tmpLink) } catch { /* leftover from a crashed run */ }
check(run(`cp x ${tmpLink}`).denied, 'a symlink UNDER the excluded /var|/tmp root is still caught')
try { fs.unlinkSync(tmpLink) } catch { /* already gone */ }
check(!run('ls /tmp/whatever').denied, 'macOS /tmp (itself a symlink) is excluded')
check(!run('cat /etc/hosts').denied, 'macOS /etc is excluded')
check(!run('ls /opt/homebrew/bin/node').denied, 'homebrew bin shims are excluded')

// --- env / ~ / composite resolution ------------------------------------------------------------
check(run(`cp x $\{SYMGUARD_T\}/linked`.replace('${SYMGUARD_T}', root)).denied, 'literal composite path')
process.env.SYMGUARD_T = root
check(run('cp x $SYMGUARD_T/linked').denied, '$VAR is resolved before checking')
check(run('cp x ${SYMGUARD_T}/linked').denied, '${VAR} is resolved before checking')
check(!run('cp a $SYMGUARD_UNSET_VAR/x').denied, 'an unresolvable $VAR is skipped, never guessed')

// --- the OTP contract --------------------------------------------------------------------------
const first = run(`cp x ${link}`)
check(!!first.otp, 'a denial issues an OTP')
check(!run(`SYMLINK_OTP=${first.otp} cp x ${link}`).denied, 'the OTP lets the SAME command through')

const second = run(`cp x ${link}`)
check(!run(`SYMLINK_OTP=${second.otp} cp x ${link}`).denied, 'a fresh OTP works once')
check(run(`SYMLINK_OTP=${second.otp} cp x ${link}`).denied, 'the SAME OTP does not work twice')

const third = run(`cp x ${link}`)
check(run(`SYMLINK_OTP=${third.otp} mv ${link} q`).denied, 'an OTP is bound to its command, not reusable for another')
check(run(`SYMLINK_OTP=DEADBEEF cp x ${link}`).denied, 'a fabricated OTP does not pass')

// --- fail-open ---------------------------------------------------------------------------------
try {
  const out = execFileSync('node', [GUARD], { input: 'not json', encoding: 'utf8' })
  check(!out.includes('deny'), 'unparseable payload falls through silently')
} catch (e) { check(false, `unparseable payload: ${e.message}`) }

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nOK — all cases' : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
