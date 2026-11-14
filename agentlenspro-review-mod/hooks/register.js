// agentlenspro-review-mod — the HARNESS runs the adversarial review and the measurement (TRDD-KZCSO0R2).
//
// Owner requirement (2026-11-14): "make the adversarial review hook a mod so it runs automatically each
// turn without having to force the model to run it. it must be part of the harness cycle, unskippable.
// the same for the measurement."
//
// HOW. At every main-thread Stop the mod asks the shared scanner (`agentlenspro review-gate
// --json-verdict`) what the turn did. When the turn has work (a write, a write-shaped command, a worker
// return that wrote) or a proposal line, the mod itself runs:
//   - MEASURE (proposal only): a `$.model.fork` lists the proposal's load-bearing assumptions, each with
//     one read-only command; the mod runs those commands itself through `$.process.run` (argv, no shell,
//     an allowlist of read-only programs) and a second fork turns the observed output into verdicts;
//   - REVIEW: a `$.model.fork` over the whole conversation (served from the prompt cache) plus the turn's
//     final message, the measure report and the working-tree diff the mod reads with git.
// A REVIEW verdict of BLOCK blocks the stop (`{ block }`): the model must address the findings in the
// same turn. The model spawns nothing; the review cannot be skipped by the model, because the scanner's
// `work`/`proposal` fields are read WHATEVER review credits the turn carries.
//
// INTERRUPTED TURNS. An Esc fires no Stop (probe E1), so `turn.complete` with `isAborted` schedules the
// same review from a timer (outside the aborted event). Its findings are shown at once ($.ui.log), injected
// as context into the next prompt, and re-checked by the next Stop: an unaddressed BLOCK blocks there.
// (`$.prompt.submit` is not used: after an abort with no user input it is dropped, probe E6.)
//
// LIMITS. At most MAX_ROUNDS blocking reviews per turn (a turn could otherwise loop on review → fix →
// review). A fork that fails (API error) is retried once, then reported on the status line; it does not
// block, because the model could not act on it. The fork has no tools: it reviews what the conversation
// and the diff show it.

import { atom, read, update } from "claude-code"

const MAX_ROUNDS = 2
const DIFF_MAX = 40000
const OBS_MAX = 4000
const MAX_ASSUMPTIONS = 8

// The pending review of an interrupted turn, kept in session state so a module reload does not lose it.
const pendingAtom = atom({ plugin: "agentlenspro-review-mod", key: "pendingReview" }, null)
// The main conversation's transcript path and cwd, from classic.* payloads (turn.complete carries neither).
const sessionAtom = atom({ plugin: "agentlenspro-review-mod", key: "lastSession" }, null)

// Blocking rounds in the current turn; reset when a new prompt starts a turn.
let roundsThisTurn = 0
// The proposal marker line, mirrored from src/cli/reviewGateTriggers.ts PROPOSAL_LINE (bold or heading prefix, any dash).
const PROPOSAL_LINE = /^[ \t]*(?:\*\*|#{1,6}[ \t]*)?PROPOSAL FOR ACTION [-–—] PLEASE REVIEW\b/m
// The turn-relative line indexes of the work and proposal the last review covered. A Stop that another hook
// blocked fires again with the SAME work; re-reviewing it would bill a whole-context fork per block (up to
// the 9-block cap). Reset at turn.complete.
let reviewedMark = { work: -1, proposal: -1, msg: null }

const errText = (err) => (err && err.message ? err.message : String(err))

async function rememberSession($, e) {
  if (!e || e.agent_id || typeof e.transcript_path !== "string" || e.transcript_path === "") return
  const seen = { transcriptPath: e.transcript_path, cwd: typeof e.cwd === "string" ? e.cwd : null }
  const prev = await read($, sessionAtom)
  if (prev && prev.transcriptPath === seen.transcriptPath && prev.cwd === seen.cwd) return
  await update($, sessionAtom, () => seen)
}

// The scanner's verdict for the turn. Returns { ok, work, proposal, reasons } or { ok: false, why }.
async function scanTurn($, session, ignoreInterruptFloor) {
  const argv = ["agentlenspro", "review-gate", "--json-verdict", "--transcript", session.transcriptPath]
  if (session.cwd) argv.push("--cwd", session.cwd)
  if (ignoreInterruptFloor) argv.push("--ignore-interrupt-floor")
  let r
  try { r = await $.process.run(argv, { timeoutMs: 90000 }) } catch (err) { return { ok: false, why: `scanner did not run: ${errText(err)}` } }
  if (r.exitCode !== 0) return { ok: false, why: `scanner exited ${r.exitCode}: ${String(r.stderr || "").trim().slice(0, 200)}` }
  let v
  try { v = JSON.parse(r.stdout) } catch { return { ok: false, why: "scanner printed unparseable output" } }
  if (!v || !v.scan || v.scan.readable !== true) return { ok: false, why: "the transcript could not be read" }
  // An older CLI does not report `work`/`proposal`; without them the harness would fall back to `demands`,
  // which a model-spawned fork can clear. Refuse that build loudly instead of reviewing less.
  if (!("work" in v) || !("proposal" in v)) return { ok: false, why: "the installed agentlenspro is too old (no work/proposal in the verdict)" }
  if (ignoreInterruptFloor && !(v.options && v.options.ignoreInterruptFloor === true)) return { ok: false, why: "the installed agentlenspro ignores --ignore-interrupt-floor" }
  if (v.work && typeof v.work.index !== "number" || typeof v.proposalIndex !== "number") return { ok: false, why: "the installed agentlenspro is too old (no work.index/proposalIndex in the verdict)" }
  return { ok: true, work: v.work, proposal: v.proposal === true, proposalIndex: v.proposalIndex, reasons: Array.isArray(v.reasons) ? v.reasons : [] }
}

// The working tree as git sees it, read by the harness so the review sees worker writes too.
async function gitContext($, cwd) {
  if (!cwd) return "(no cwd known: no git context)"
  const run = async (args) => {
    try {
      const r = await $.process.run(["git", "-C", cwd, ...args], { timeoutMs: 20000 })
      return r.exitCode === 0 ? String(r.stdout) : null
    } catch { return null }
  }
  if ((await run(["rev-parse", "--is-inside-work-tree"])) === null) return "(not a git work tree)"
  // A repository with no commit yet has no HEAD, and `git diff HEAD` fails there: the probe of 2026-11-14
  // reported a fresh `git init` repo as "not a git work tree". Diff against the empty tree in that case.
  const hasHead = (await run(["rev-parse", "--verify", "-q", "HEAD"])) !== null
  const emptyTree = hasHead ? null : ((await run(["hash-object", "-t", "tree", "/dev/null"])) || "").trim()
  const base = hasHead ? "HEAD" : emptyTree
  const stat = base ? ((await run(["diff", base, "--stat"])) || "") : ""
  const status = (await run(["status", "--short"])) || ""
  const diff = base ? ((await run(["diff", base])) || "") : ""
  const log = (await run(["log", "-3", "--stat", "--format=commit %h %s"])) || ""
  // `git diff HEAD` never shows an UNTRACKED file, so a new file (the commonest write) would be invisible to
  // the review: list them and include their text, capped.
  const untracked = ((await run(["ls-files", "--others", "--exclude-standard"])) || "").split("\n").filter(Boolean)
  let newFiles = ""
  for (const f of untracked.slice(0, 20)) {
    let body
    try { body = String(await $.fs.read(`${cwd}/${f}`)) } catch (err) { body = `(unreadable: ${errText(err)})` }
    newFiles += `\n--- new file ${f}\n${body.length > 4000 ? body.slice(0, 4000) + `\n[... cut at 4000 of ${body.length} chars]` : body}\n`
  }
  if (untracked.length > 20) newFiles += `\n[... ${untracked.length - 20} more untracked files not shown]\n`
  const all = diff + newFiles
  const cut = all.length > DIFF_MAX ? all.slice(0, DIFF_MAX) + `\n[... diff cut at ${DIFF_MAX} of ${all.length} chars]` : all
  return `git status --short:\n${status || "(clean)"}\n\ngit diff ${hasHead ? "HEAD" : "(no commit yet: against the empty tree)"} --stat:\n${stat || "(no tracked changes)"}\n\nlast 3 commits:\n${log}\n\ngit diff ${hasHead ? "HEAD" : "(no commit yet)"} + new files:\n${cut || "(empty)"}`
}

// ── MEASURE ────────────────────────────────────────────────────────────────────────────────────
// Read-only programs the mod will run for a measurement. argv only, no shell, so no pipe, redirect or
// expansion can turn a read into a write; the per-program checks close the write flags those have.
const READ_ONLY = new Set(["grep", "rg", "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "diff", "jq", "tldr", "which", "pwd", "date", "find", "git", "sort", "uniq", "cut", "test", "agentlenspro"])
const GIT_READ = new Set(["log", "show", "diff", "status", "grep", "ls-files", "rev-parse", "blame", "describe", "cat-file", "ls-tree", "merge-base", "shortlog"])
const AGENTLENS_READ = new Set(["review-gate", "list", "help", "statusline-history", "last-compact", "cache-expired", "cache-state"])

function refuseArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) return "argv is not a list of strings"
  const prog = argv[0]
  if (!READ_ONLY.has(prog)) return `${prog} is not on the read-only list`
  const args = argv.slice(1)
  if (prog === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return "find with a write/exec action"
  if (prog === "git") {
    const sub = args.find((a) => !a.startsWith("-"))
    if (!GIT_READ.has(sub)) return `git ${sub} is not a read-only subcommand`
    if (args.some((a) => a.startsWith("--output") || a === "-o")) return "git with an output file"
    // -c / --config-env can set core.pager, diff.external or core.fsmonitor (all execute); -O and
    // --ext-diff run a program too.
    if (args.some((a) => a === "-c" || a.startsWith("-c") && !a.startsWith("--") || a.startsWith("--config-env") || a.startsWith("-O") || a.startsWith("--open-files-in-pager") || a === "--ext-diff")) return "git option that runs a program"
  }
  if (prog === "sort" && args.some((a) => a === "-o" || a.startsWith("--output") || a.startsWith("--compress-program"))) return "sort with an output file or a program"
  // uniq IN OUT writes OUT; file -C compiles a magic file; date -s sets the clock.
  if (prog === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return "uniq with an output file"
  if (prog === "file" && args.some((a) => a === "-C" || a === "--compile")) return "file --compile writes"
  if (prog === "date" && args.some((a) => a === "-s" || a.startsWith("--set"))) return "date --set"
  if (prog === "rg" && args.some((a) => a.startsWith("--pre"))) return "rg --pre runs a command"
  if (prog === "agentlenspro" && (!AGENTLENS_READ.has(args[0]) || (args[0] === "review-gate" && !args.includes("--json-verdict") && !args.includes("--directive")))) return "agentlenspro verb is not read-only"
  return null
}

function extractJsonArray(text) {
  const a = text.indexOf("[")
  const b = text.lastIndexOf("]")
  if (a === -1 || b <= a) return null
  try { const v = JSON.parse(text.slice(a, b + 1)); return Array.isArray(v) ? v : null } catch { return null }
}

const HARNESS_HEAD = "[agentlenspro-review-mod: this request comes from the HARNESS, not from the user. You are not the main agent and you have NO tools: do not call any tool, answer at once in text.]"

async function fork($, prompt) {
  let r = await $.model.fork({ prompt })
  if (!r.isAnswered && r.reason === "api-error") r = await $.model.fork({ prompt })
  return r
}

async function runMeasure($, session, lastMessage) {
  const plan = await fork($, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 1 of 2: plan).",
    "The most recent turn above contains a proposal (a line starting \"PROPOSAL FOR ACTION - PLEASE REVIEW\").",
    lastMessage ? `Its final message was:\n<<<\n${lastMessage}\n>>>` : "",
    `List at most ${MAX_ASSUMPTIONS} LOAD-BEARING assumptions the proposal rests on, each with ONE read-only command that settles it.`,
    "Output ONLY a JSON array, nothing else: [{\"assumption\": \"...\", \"argv\": [\"grep\", \"-n\", \"x\", \"/abs/path\"], \"expect\": \"what output confirms it\"}]",
    "argv runs WITHOUT a shell: no pipes, redirects, globs or $VARS; absolute paths only.",
    `Allowed programs: ${[...READ_ONLY].join(" ")}; git only with ${[...GIT_READ].join(" ")}.`,
  ].join("\n"))
  if (!plan.isAnswered) return `MEASURE could not plan: ${plan.reason}`
  const items = (extractJsonArray(plan.text) || []).slice(0, MAX_ASSUMPTIONS)
  if (items.length === 0) return `MEASURE planned no runnable assumption. Raw plan:\n${plan.text.slice(0, 2000)}`
  const rows = []
  for (const it of items) {
    const argv = it && it.argv
    const refused = refuseArgv(argv)
    if (refused) { rows.push(`ASSUMPTION: ${it && it.assumption}\nCOMMAND: ${JSON.stringify(argv)}\nOBSERVED: NOT RUN — ${refused}`); continue }
    let obs
    try {
      const r = await $.process.run(argv, { cwd: session.cwd || undefined, timeoutMs: 20000 })
      const out = `${r.stdout || ""}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`
      obs = `exit ${r.exitCode}\n${out.length > OBS_MAX ? out.slice(0, OBS_MAX) + `\n[... cut at ${OBS_MAX} of ${out.length} chars]` : out}`
    } catch (err) { obs = `did not run: ${errText(err)}` }
    rows.push(`ASSUMPTION: ${it.assumption}\nCOMMAND: ${JSON.stringify(argv)}\nEXPECT: ${it.expect}\nOBSERVED: ${obs}`)
  }
  const verdicts = await fork($, [
    HARNESS_HEAD,
    "ROLE: MEASURE (step 2 of 2: verdicts).",
    "The harness ran these read-only commands for the proposal in the most recent turn. Judge ONLY from the OBSERVED output.",
    rows.join("\n\n"),
    "For each row output: ASSUMPTION / COMMAND / OBSERVED (one line, the decisive part) / VERDICT (confirmed | refuted | unmeasurable).",
    "Then one line: LOAD-BEARING REFUTED: <list or none>.",
  ].join("\n"))
  const head = "[AGENTLENSPRO-MEASURE-REPORT] (run by the harness)"
  return verdicts.isAnswered ? `${head}\n${verdicts.text}` : `${head}\nverdict step failed (${verdicts.reason}); raw rows:\n${rows.join("\n\n")}`
}

// ── REVIEW ─────────────────────────────────────────────────────────────────────────────────────
function reviewPrompt({ interrupted, lastMessage, scan, measure, pending, debt, git, round }) {
  return [
    HARNESS_HEAD,
    "ROLE: REVIEW",
    interrupted
      ? "The user INTERRUPTED the most recent turn above (Esc). Review the work that turn did before it was cut off."
      : `The most recent turn above just ended${round > 1 ? ` (review round ${round}: the previous round's findings are in the conversation; check each was fixed or explicitly rejected with a reason)` : ""}.`,
    lastMessage ? `Its final message to the user was:\n<<<\n${lastMessage}\n>>>` : "",
    `Scanner: work = ${scan.work ? `${scan.work.cause} — ${scan.work.detail}` : "none"}; proposal = ${scan.proposal}.`,
    measure ? `\n${measure}\n` : "",
    pending ? `An earlier INTERRUPTED turn was reviewed by the harness with these findings; check whether this turn addressed them:\n<<<\n${pending}\n>>>` : "",
    debt ? `An earlier stop ended WITHOUT a harness review (${debt}). Review that earlier work too: it is in the conversation above.` : "",
    `Working tree, read by the harness:\n${git}`,
    "",
    "Review ONLY the most recent turn's work and claims. Hunt: a PROXY read in place of the thing (a pipe's exit status for the tool's, a preview for the file, one run for the variance, an assumed format for the real one); claims stronger than their evidence; broken references; untested or unverified changes; silent failure paths; destructive or irreversible actions without confirmation; scope beyond the request.",
    "You are the REVIEWER, not the agent: write about the main agent in the third person (\"the agent\", \"the turn\"). Never write \"I\", \"me\" or \"my\" about the agent's actions.",
    "Never recommend, in a finding or in SETTLE WITH, an action the user forbade in the conversation (for example running code the user said not to run); if the only settling check is forbidden, write that instead of the command.",
    "Answer both: the strongest reason NOT to have made this change, and the most likely way it is wrong.",
    "OUTPUT FORMAT, strictly:",
    "Line 1: exactly \"VERDICT: PASS\" or \"VERDICT: BLOCK\" (BLOCK only when at least one finding is a BLOCKER).",
    "Then numbered findings: [BLOCKER|SHOULD-FIX|NIT] claim — evidence — fix.",
    "Last line: \"WEAKEST LINK: <one sentence> — SETTLE WITH: <one command>\".",
  ].filter((s) => s !== "").join("\n")
}

// The verdict is the FIRST line that starts with "VERDICT:"; a preface line before it is tolerated, a quoted
// "VERDICT: BLOCK" inside a later finding is not read. No such line = a malformed answer, never a PASS.
function parseVerdict(text) {
  // Markdown decoration ("**VERDICT: BLOCK**", "# VERDICT: PASS", "> VERDICT: ...") is stripped first:
  // models often bold the line, and an unmatched BLOCK would fail open as a skip.
  const line = text.split("\n").map((l) => l.trim().replace(/^[#>*_\s]+/, "").replace(/[*_\s]+$/, "")).find((l) => /^VERDICT:/.test(l))
  if (!line) return { ok: false, why: "the review answer has no VERDICT line" }
  if (/^VERDICT:\s*BLOCK\b/.test(line)) return { ok: true, block: true, text }
  if (/^VERDICT:\s*PASS\b/.test(line)) return { ok: true, block: false, text }
  return { ok: false, why: `unreadable verdict line: ${line.slice(0, 80)}` }
}

async function runReview($, args) {
  const r = await fork($, reviewPrompt(args))
  if (!r.isAnswered) return { ok: false, why: r.reason }
  const text = r.text.trim()
  return parseVerdict(text)
}

// The interrupted turn's review, from a timer: outside the aborted event, so the fork is not cut by it.
async function reviewInterrupted($) {
  try {
    const session = await read($, sessionAtom)
    if (!session) { await defer($, "interrupted turn: no transcript path seen yet"); return }
    const scan = await scanTurn($, session, true)
    if (!scan.ok) { await defer($, `interrupted turn: ${scan.why}`); return }
    if (!scan.work && !scan.proposal) return
    const git = await gitContext($, session.cwd)
    const measure = scan.proposal ? await runMeasure($, session, null) : null
    let res = await runReview($, { interrupted: true, lastMessage: null, scan, measure, pending: null, git, round: 1 })
    if (!res.ok) {
      // A fork from the aborted conversation can fail; fall back to a plain completion over the transcript.
      let excerpt = ""
      try { excerpt = JSON.stringify((await $.session.messages()).slice(-40)).slice(-60000) } catch (err) { excerpt = `(messages unavailable: ${errText(err)})` }
      const c = await $.model.complete({ model: "sonnet", system: reviewPrompt({ interrupted: true, lastMessage: null, scan, measure, pending: null, git, round: 1 }), prompt: `The interrupted conversation's last messages (JSON):\n${excerpt}`, maxTokens: 4000 })
      res = c.isAnswered ? parseVerdict(c.text.trim()) : { ok: false, why: `fork: ${res.why}; completion: ${c.reason}` }
    }
    if (!res.ok) { await defer($, `interrupted turn: ${res.why}`); return }
    const text = `${measure ? measure + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, interrupted turn)\n${res.text}`
    await update($, pendingAtom, () => ({ text, block: res.block, injected: false, at: Date.now() }))
    $.ui.log(text)
    $.ui.status(res.block ? "review: interrupted turn — BLOCK, findings go to the next prompt" : "review: interrupted turn — PASS")
  } catch (err) {
    await defer($, `interrupted turn: ${errText(err)}`)
  }
}

// A review that could not run is NOT a pass. The status line alone is lost in an unattended session, so
// every deferral is also written to the transcript log and counted in the plugin store (key "deferred").
// Nothing is ever dropped: a stop the harness could not review leaves a DEBT in session state, and the next
// stop must review that work (it is in the conversation the fork reads), even when that turn changed nothing.
async function defer($, why) {
  $.ui.log(`REVIEW DEFERRED to the next stop (not dropped): ${why}`)
  $.ui.status(`review: deferred — ${why}`)
  try { const n = (await $.store.get("deferred")) || 0; await $.store.set("deferred", n + 1) } catch { /* the log line above records it */ }
  const prev = await read($, pendingAtom)
  await update($, pendingAtom, () => ({ ...(prev || { text: "", block: false, injected: true, at: Date.now() }), debt: true, debtWhy: why }))
}
export const register = (on) => {
  on("classic.SessionStart", async ($, e, next) => {
    try { await rememberSession($, e) } catch (err) { $.ui.status(`review: session not remembered — ${errText(err)}`) }
    return next(e)
  })

  on("classic.UserPromptSubmit", async ($, e, next) => {
    // The round cap is NOT reset here: UserPromptSubmit also fires for hand-backs (probe M5) and maybe for a
    // Stop-block continuation, which would reset the cap and loop. It resets at turn.complete only.
    try { await rememberSession($, e) } catch (err) { $.ui.status(`review: session not remembered — ${errText(err)}`) }
    return next(e)
  })

  // Deliver a pending interrupted-turn review with whatever prompt starts the next turn.
  on("prompt.submit", async ($, e, next) => {
    try {
      const pending = await read($, pendingAtom)
      if (!pending || pending.injected) return next(e)
      await update($, pendingAtom, () => ({ ...pending, injected: true }))
      return next({ ...e, context: [...((e && e.context) || []), `The harness reviewed your INTERRUPTED previous turn. Address every BLOCKER before anything else:\n${pending.text}`] })
    } catch (err) {
      $.ui.status(`review: pending review not injected — ${errText(err)}`)
      return next(e)
    }
  })

  on("turn.complete", async ($, e, next) => {
    if (e && !e.agentId) { roundsThisTurn = 0; reviewedMark = { work: -1, proposal: -1, msg: null } }
    if (e && e.isAborted && !e.agentId) $.clock.after(1500, () => reviewInterrupted($))
    return next(e)
  })

  // THE GATE. Runs the measurement and the review itself and blocks the stop on a BLOCK verdict.
  on("classic.Stop", async ($, e, next) => {
    const r = await next(e)
    if (!e || e.agent_id) return r
    // A review that could not run must not let the stop through (owner: "unskippable"). It blocks and the next
    // stop retries, up to MAX_ROUNDS per turn; past that it is logged as skipped (the engine's own 9-block cap
    // would end the turn anyway, and an endless block would wedge the session).
    const failClosed = async (why) => {
      if (roundsThisTurn < MAX_ROUNDS) {
        roundsThisTurn++
        $.ui.log(`REVIEW FAILED, stop blocked for a retry (round ${roundsThisTurn}/${MAX_ROUNDS}): ${why}`)
        return { ...r, block: [r.block, `[agentlenspro-review-mod] The harness could not review this turn (${why}). End your turn again: the harness retries the review at the next stop. Do not spawn a review fork.`].filter(Boolean).join("\n\n") }
      }
      await defer($, `${why}; ${MAX_ROUNDS} retries this turn failed`)
      return r
    }
    try {
      await rememberSession($, e)
      const session = await read($, sessionAtom)
      if (!session) return await failClosed("no transcript path")
      const pending = await read($, pendingAtom)
      const scan = await scanTurn($, session, false)
      if (!scan.ok) return await failClosed(scan.why)
      // The engine fires Stop BEFORE the turn's final assistant message reaches the JSONL, so a text-only
      // proposal turn scans as nothing (measured 2026-11-14: work None, proposal false on a turn whose only
      // message was the proposal, and no measurement ran). The event carries that message: check it here.
      const lastMessage = typeof e.last_assistant_message === "string" ? e.last_assistant_message : null
      const proposalFromLast = !scan.proposal && lastMessage !== null && PROPOSAL_LINE.test(lastMessage)
      if (proposalFromLast) scan.proposal = true
      const pendingBlock = pending && pending.block ? pending.text : null
      const debt = pending && pending.debt ? pending.debtWhy : null
      const clearPending = async () => { if (pending) await update($, pendingAtom, () => null) }
      if (!scan.work && !scan.proposal && !debt) {
        await clearPending()
        if (pendingBlock && roundsThisTurn < MAX_ROUNDS) {
          roundsThisTurn++
          return { ...r, block: [r.block, `[agentlenspro-review-mod] The harness review of your INTERRUPTED earlier turn found BLOCKERS and this turn did not address them. Fix each one (or state why it is rejected), then end the turn.\n\n${pendingBlock}`].filter(Boolean).join("\n\n") }
        }
        if (pendingBlock) await defer($, `cap of ${MAX_ROUNDS} blocking rounds reached; the interrupted turn's BLOCK review was not re-checked`)
        return r
      }
      const workAt = scan.work ? scan.work.index : -1
      if (!debt && workAt <= reviewedMark.work && scan.proposalIndex <= reviewedMark.proposal && !(proposalFromLast && lastMessage !== reviewedMark.msg)) {
        // Nothing new since the last harness review of this turn (a Stop re-fired after another hook blocked).
        await clearPending()
        return r
      }
      if (roundsThisTurn >= MAX_ROUNDS) {
        await defer($, `cap of ${MAX_ROUNDS} blocking rounds reached this turn`)
        return r
      }
      $.ui.status(scan.proposal ? "review: measuring the proposal, then reviewing…" : "review: reviewing this turn…")
      const measure = scan.proposal ? await runMeasure($, session, lastMessage) : null
      const git = await gitContext($, session.cwd)
      const res = await runReview($, { interrupted: false, lastMessage, scan, measure, pending: pendingBlock, debt, git, round: roundsThisTurn + 1 })
      if (!res.ok) return await failClosed(`the review fork failed (${res.why})`)
      reviewedMark = { work: workAt, proposal: scan.proposalIndex, msg: lastMessage }
      await clearPending()
      const report = `${measure ? measure + "\n\n" : ""}[AGENTLENSPRO-REVIEW-REPORT] (run by the harness)\n${res.text}`
      if (!res.block) {
        $.ui.log(report)
        $.ui.status("review: PASS")
        // PASS is logged only: Stop additionalContext may start a continuation turn (unmeasured), costing a
        // model turn per changing turn. The report stays in the transcript log for the user.
        return r
      }
      roundsThisTurn++
      $.ui.status(`review: BLOCK (round ${roundsThisTurn}/${MAX_ROUNDS})`)
      return { ...r, block: [r.block, `[agentlenspro-review-mod] The harness ran an adversarial review of this turn and it found BLOCKERS. Address each finding: fix it, or state why you reject it. Do not spawn a review fork: the harness reviews again when you stop.\n\n${report}`].filter(Boolean).join("\n\n") }
    } catch (err) {
      return await failClosed(errText(err))
    }
  })
}
