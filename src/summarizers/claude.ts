import { Span } from '../shared/telemetryTypes'
import { SessionSummaryCard, TimelineEntry, EditDetail } from '../shared/summarizerTypes'
import { disjointBuckets, contextTokens } from '../shared/tokenBuckets'
import {
  getAttrStr, getAttrInt, nanoToMs, CLAUDE_WRITE_TOOLS, FULL_WRITE_TOOLS,
  extractResponseText, extractTokenCounts, normalizeUserRequest, getGenAiModel,
  commonPathPrefix, findProjectRoot,
} from './helpers'
import { callBodyRegistry } from '../rawBodyContext'

function strOrUndef(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') { return undefined }
  return String(v)
}

export function buildClaudeSessions(
  claudeInteractionSpans: Span[],
  spansByTraceId: Record<string, Span[]>
): SessionSummaryCard[] {
  // Phase B of the token-feed fix (reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md
  // §4bis): one Claude session used to fragment into one card PER interaction span, keyed by the
  // interaction spanId — never the transcript UUID — so a long session served as up to hundreds of
  // per-trace OTEL cards next to its single log card, and the log/OTEL id merge could never collide.
  // The `session.id` attribute on interaction spans carries the real transcript UUID: group by it
  // and emit ONE session-scoped card per UUID (sessionId = the UUID). Interactions with NO
  // session.id attr keep the per-interaction card — fail-soft, we never invent an identity.
  const out: SessionSummaryCard[] = []
  const groups = new Map<string, SessionSummaryCard[]>()
  for (const interaction of claudeInteractionSpans) {
    const card = buildInteractionCard(interaction, spansByTraceId)
    const claudeSessionId = getAttrStr(interaction, 'session.id')
    if (!claudeSessionId) { out.push(card); continue }
    const group = groups.get(claudeSessionId)
    if (group) { group.push(card) } else { groups.set(claudeSessionId, [card]) }
  }
  for (const [claudeSessionId, slices] of groups) {
    out.push(mergeInteractionSlices(claudeSessionId, slices))
  }
  return out
}

// Chronology key shared by the per-card timeline sort and the cross-slice merge: entries with no
// parseable timestamp sort LAST so a missing ISO string can't scramble the well-timed entries.
function timelineTsKey(e: TimelineEntry): number {
  const t = Date.parse(e.timestamp || '')
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

/**
 * Rolls the per-interaction slice cards of ONE Claude session (same `session.id` transcript UUID)
 * into a single session-scoped card: buckets/turns/tool counts SUM, file sets UNION, the timeline
 * concatenates in time order, startTime is the earliest slice and durationMs spans the whole group.
 * model/workspace/userRequest come from the most-informative slice (longest timeline), falling back
 * per-field to the first slice in time order that carries a real value. sessionId becomes the
 * transcript UUID so the card finally collides with — and can be reconciled against — the log card
 * of the same session (see feedMergePolicy.ts for who wins that collision).
 */
function mergeInteractionSlices(claudeSessionId: string, slices: SessionSummaryCard[]): SessionSummaryCard {
  const startMsOf = (c: SessionSummaryCard): number => {
    const t = Date.parse(c.startTime || '')
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
  }
  const ordered = slices.slice().sort((a, b) => startMsOf(a) - startMsOf(b))
  if (ordered.length === 1) { return { ...ordered[0], sessionId: claudeSessionId } }

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0
  let totalLlmCalls = 0, totalToolCalls = 0, errors = 0
  const toolCounts: Record<string, number> = {}
  const filesRead = new Set<string>()
  const filesSearched = new Set<string>()
  const filesChanged = new Set<string>()
  const filesWritten = new Set<string>()
  const timeline: TimelineEntry[] = []
  const backgroundSpans: SessionSummaryCard['backgroundSpans'] = []
  let minStartMs = Number.MAX_SAFE_INTEGER
  let maxEndMs = 0
  for (const s of ordered) {
    inputTokens += s.inputTokens
    outputTokens += s.outputTokens
    cacheReadTokens += s.cacheReadTokens
    cacheCreateTokens += s.cacheCreateTokens
    totalLlmCalls += s.totalLlmCalls
    totalToolCalls += s.totalToolCalls
    errors += s.errors
    for (const [tool, n] of Object.entries(s.toolCounts)) { toolCounts[tool] = (toolCounts[tool] || 0) + n }
    for (const f of s.filesRead) { filesRead.add(f) }
    for (const f of s.filesSearched) { filesSearched.add(f) }
    for (const f of s.filesChanged) { filesChanged.add(f) }
    for (const f of s.filesWritten) { filesWritten.add(f) }
    timeline.push(...s.timeline)
    backgroundSpans.push(...s.backgroundSpans)
    const st = startMsOf(s)
    if (st !== Number.MAX_SAFE_INTEGER) {
      if (st < minStartMs) { minStartMs = st }
      const end = st + (s.durationMs > 0 ? s.durationMs : 0)
      if (end > maxEndMs) { maxEndMs = end }
    }
  }
  // Slices are already sorted by start and each slice timeline is internally time-sorted, but
  // interactions can overlap (background/sidechain turns) — re-sort globally with the same
  // stable comparator a single card uses.
  timeline.sort((a, b) => timelineTsKey(a) - timelineTsKey(b))

  // Most-informative slice = the one with the richest timeline; per-field fallback scans the
  // group in time order so a placeholder never shadows a real value carried by another slice.
  const informative = ordered.reduce((best, s) => (s.timeline.length > best.timeline.length ? s : best), ordered[0])
  const isPlaceholderRequest = (r: string): boolean =>
    !r || r === '[prompt redacted]' || r === '[session in progress]'
  const userRequest = !isPlaceholderRequest(informative.userRequest)
    ? informative.userRequest
    : (ordered.find(s => !isPlaceholderRequest(s.userRequest))?.userRequest ?? informative.userRequest)
  const model = informative.model || ordered.find(s => s.model)?.model || ''
  const workspace = informative.workspace || ordered.find(s => s.workspace)?.workspace || ''
  const base = ordered[0]

  const totalContext = contextTokens({ inputTokens, cacheReadTokens, cacheCreateTokens })
  // A grouped card can only be suppressed-note-free if SOME slice found a changed path; when the
  // union is empty, surface the first slice note (they all carry the same telemetry-config advice).
  const filesChangedNote = filesChanged.size > 0
    ? undefined
    : ordered.find(s => s.filesChangedNote)?.filesChangedNote

  return {
    // The earliest interaction's trace anchors the card (traceId is single-valued; background-span
    // association and synth-row cleanup key on it — fail-soft for the later traces of the group).
    ...base,
    sessionId: claudeSessionId,
    // A session with ANY user-initiated interaction is a user session; sidechain-only groups
    // (every interaction stamped is_sidechain/parented) stay 'agent'.
    initiator: ordered.some(s => s.initiator === 'user') ? 'user' as const : base.initiator,
    accountId: ordered.find(s => s.accountId)?.accountId,
    workspace,
    userRequest,
    model,
    turns: totalLlmCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    cacheHitRate: totalContext > 0 ? cacheReadTokens / totalContext : 0,
    durationMs: (minStartMs !== Number.MAX_SAFE_INTEGER && maxEndMs > minStartMs) ? maxEndMs - minStartMs : base.durationMs,
    startTime: minStartMs !== Number.MAX_SAFE_INTEGER ? new Date(minStartMs).toISOString() : base.startTime,
    filesRead: Array.from(filesRead),
    filesSearched: Array.from(filesSearched),
    filesChanged: Array.from(filesChanged),
    filesWritten: Array.from(filesWritten),
    filesChangedNote,
    toolCounts,
    totalToolCalls,
    totalLlmCalls,
    errors,
    outcome: 'unknown' as const,
    timeline,
    backgroundSpans,
    loopSignals: [],
  }
}

/** Builds the per-interaction slice card — ONE claude_code.interaction span plus its trace tree.
 *  This is the pre-Phase-B unit of aggregation; buildClaudeSessions above groups these slices by
 *  the transcript UUID. (Body kept verbatim from the former map callback, hence its indentation.) */
function buildInteractionCard(
  interaction: Span,
  spansByTraceId: Record<string, Span[]>
): SessionSummaryCard {
    const traceSpans = (spansByTraceId[interaction.traceId] || [])
      .filter(s => s.spanId !== interaction.spanId)
      .sort((a, b) => nanoToMs(a.startTime) - nanoToMs(b.startTime))

    const topSpans = traceSpans.filter(s =>
      s.name === 'claude_code.llm_request' || s.name === 'claude_code.tool'
    )

    const childrenBySpanId: Record<string, Span[]> = {}
    for (const s of traceSpans) {
      if (s.parentSpanId) {
        if (!childrenBySpanId[s.parentSpanId]) { childrenBySpanId[s.parentSpanId] = [] }
        childrenBySpanId[s.parentSpanId].push(s)
      }
    }

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0
    let totalLlmCalls = 0, totalToolCalls = 0, errors = 0
    let model = ''
    const toolCounts: Record<string, number> = {}
    const filesRead = new Set<string>()
    const filesSearched = new Set<string>()
    const filesChanged = new Set<string>()
    const filesWritten = new Set<string>()
    const allAbsFilePaths = new Set<string>()
    let missingChangedFilePathCalls = 0

    // 1-based turn index for the trace tree: each llm_request span opens a turn; the tool spans
    // that follow it belong to that same turn (Claude requests tools, then they run). Tools before
    // the first llm_request fall into turn 1.
    let turnCounter = 0
    const timeline: TimelineEntry[] = topSpans.flatMap(child => {
      const childStart = nanoToMs(child.startTime)
      const childEnd = nanoToMs(child.endTime)
      const childDur = childEnd - childStart || getAttrInt(child, 'duration_ms')
      const isError = child.status?.code === 2
      if (isError) { errors++ }
      const ts = childStart > 0 ? new Date(childStart).toISOString() : ''

      if (child.name === 'claude_code.llm_request') {
        totalLlmCalls++
        turnCounter++
        // llm_request usage is Anthropic-shaped (input already cache-excluded) — the constructor
        // is a pass-through here, but it is the ONE place the disjoint invariant is enforced.
        const { input, output, cacheRead, cacheCreate } = extractTokenCounts(child)
        const b = disjointBuckets({ input, output, cacheRead, cacheCreate }, 'anthropic')
        const ttft = getAttrInt(child, 'ttft_ms')
        const childModel = getGenAiModel(child)
        if (childModel) { model = childModel }
        inputTokens += b.inputTokens
        outputTokens += b.outputTokens
        cacheReadTokens += b.cacheReadTokens
        cacheCreateTokens += b.cacheCreateTokens

        const stopReason = getAttrStr(child, 'stop_reason')
        const action = stopReason === 'tool_use' ? 'called tools'
          : stopReason === 'end_turn' ? 'text response'
          : stopReason || 'unknown'
        const claudeOutputMsgs = getAttrStr(child, 'gen_ai.output.messages')
        const responseText = extractResponseText(claudeOutputMsgs)

        // Extract file paths and edit details from tool_use blocks in the LLM response.
        // Primary source for Claude Code because tool_input on claude_code.tool spans
        // requires CLAUDE_CODE_ENHANCED_TELEMETRY_BETA.
        const llmEditDetails: EditDetail[] = []
        if (claudeOutputMsgs) {
          try {
            const msgs = JSON.parse(claudeOutputMsgs) as unknown[]
            if (Array.isArray(msgs)) {
              for (const msg of msgs) {
                const m = msg as { role?: string; content?: unknown }
                if (m.role !== 'assistant') { continue }
                const content = Array.isArray(m.content) ? m.content : []
                for (const block of content) {
                  const b = block as { type?: string; name?: string; input?: Record<string, unknown> }
                  if (b.type !== 'tool_use' || !b.input) { continue }
                  const toolN = b.name || ''
                  let foundChangedPath = false
                  const fp = String(b.input.file_path || b.input.filePath || '')
                  if (fp) {
                    if (CLAUDE_WRITE_TOOLS.has(toolN)) {
                      filesChanged.add(fp)
                      if (FULL_WRITE_TOOLS.has(toolN)) filesWritten.add(fp)
                      foundChangedPath = true
                      llmEditDetails.push({
                        filePath: fp,
                        toolName: toolN,
                        oldString: strOrUndef(b.input.old_string || b.input.oldString),
                        newString: strOrUndef(b.input.new_string || b.input.newString),
                        content: strOrUndef(b.input.content),
                      })
                    } else if (toolN === 'Read') {
                      filesRead.add(fp.split('/').pop() || fp)
                    } else if (toolN === 'Glob' || toolN === 'Grep') {
                      filesSearched.add(String(b.input.pattern || b.input.query || fp))
                    }
                  }
                  if (toolN === 'MultiEdit' && Array.isArray(b.input.edits)) {
                    for (const e of b.input.edits as Array<Record<string, unknown>>) {
                      const efp = e.file_path || e.filePath
                      if (efp) {
                        filesChanged.add(String(efp))
                        foundChangedPath = true
                        llmEditDetails.push({
                          filePath: String(efp),
                          toolName: 'Edit',
                          oldString: strOrUndef(e.old_string || e.oldString),
                          newString: strOrUndef(e.new_string || e.newString),
                        })
                      }
                    }
                  }
                  if (CLAUDE_WRITE_TOOLS.has(toolN) && !foundChangedPath) {
                    missingChangedFilePathCalls++
                  }
                }
              }
            }
          } catch { /* ignore */ }
        }

        return [{
          type: 'llm' as const,
          spanId: child.spanId,
          label: childModel || 'LLM',
          turn: turnCounter,
          model: childModel,
          // RAW uncached input — timeline entries carry the SAME four disjoint buckets as the card.
          // This entry stored input+cacheRead+cacheCreate (incl-cache) until 2026-07-10 while the
          // log-derived entries were raw, so the two feeds' entries disagreed and every consumer
          // had to guess the convention (webview derives context-size as contextTokens() instead).
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheReadTokens: b.cacheReadTokens || undefined,
          cacheCreateTokens: b.cacheCreateTokens || undefined,
          ttft,
          durationMs: childDur,
          action,
          responseText: responseText || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
          editDetails: llmEditDetails.length > 0 ? llmEditDetails : undefined,
        }]
      } else {
        // claude_code.tool
        totalToolCalls++
        const toolName = getAttrStr(child, 'tool_name') || child.name
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1
        const isWriteTool = CLAUDE_WRITE_TOOLS.has(toolName)

        const argsStr = getAttrStr(child, 'tool_input')
          || getAttrStr(child, 'input')
          || getAttrStr(child, 'gen_ai.tool.call.arguments')
          || getAttrStr(child, 'full_command')   // Bash: raw shell command
          || getAttrStr(child, 'file_path')       // Read/Edit/Write: file path
        let foundChangedPath = false
        const toolEditDetails: EditDetail[] = []
        if (argsStr) {
          try {
            const args = JSON.parse(argsStr)
            const fp = args.file_path || args.filePath
            if (fp) {
              const fpStr = String(fp)
              if (fpStr.startsWith('/')) { allAbsFilePaths.add(fpStr) }
              if (CLAUDE_WRITE_TOOLS.has(toolName)) {
                filesChanged.add(fpStr)
                if (FULL_WRITE_TOOLS.has(toolName)) filesWritten.add(fpStr)
                foundChangedPath = true
                toolEditDetails.push({
                  filePath: fpStr,
                  oldString: strOrUndef(args.old_string || args.oldString),
                  newString: strOrUndef(args.new_string || args.newString),
                  content: strOrUndef(args.content),
                })
              } else if (toolName === 'Read') {
                filesRead.add(fpStr.split('/').pop() || fpStr)
              } else if (toolName === 'Glob' || toolName === 'Grep') {
                filesSearched.add(args.pattern || args.query || fpStr)
              }
            }
            if (toolName === 'MultiEdit' && Array.isArray(args.edits)) {
              for (const e of args.edits as Array<Record<string, unknown>>) {
                const efp = e.file_path || e.filePath
                if (efp) {
                  const efpStr = String(efp)
                  if (efpStr.startsWith('/')) { allAbsFilePaths.add(efpStr) }
                  filesChanged.add(efpStr)
                  foundChangedPath = true
                  toolEditDetails.push({
                    filePath: String(efp),
                    oldString: strOrUndef(e.old_string || e.oldString),
                    newString: strOrUndef(e.new_string || e.newString),
                  })
                }
              }
            }
          } catch { /* skip */ }
        }
        // Fallback: claude_code.tool spans expose file_path as a direct attribute
        // even when tool_input is absent (default telemetry without OTEL_LOG_TOOL_DETAILS).
        if (!foundChangedPath) {
          const directFp = getAttrStr(child, 'file_path')
          if (directFp) {
            if (directFp.startsWith('/')) { allAbsFilePaths.add(directFp) }
            if (CLAUDE_WRITE_TOOLS.has(toolName)) {
              filesChanged.add(directFp)
              if (FULL_WRITE_TOOLS.has(toolName)) filesWritten.add(directFp)
              foundChangedPath = true
            } else if (toolName === 'Read') {
              filesRead.add(directFp.split('/').pop() || directFp)
            } else if (toolName === 'Glob' || toolName === 'Grep') {
              filesSearched.add(directFp)
            }
          }
        }
        if (isWriteTool && !foundChangedPath) {
          missingChangedFilePathCalls++
        }

        const toolEntry: TimelineEntry = {
          type: 'tool' as const,
          spanId: child.spanId,
          label: toolName,
          turn: Math.max(1, turnCounter),
          durationMs: childDur || getAttrInt(child, 'duration_ms'),
          toolInput: argsStr || undefined,
          isError,
          errorMessage: isError ? (child.status?.message || undefined) : undefined,
          timestamp: ts,
          editDetails: toolEditDetails.length > 0 ? toolEditDetails : undefined,
        }

        const blockedSpan = (childrenBySpanId[child.spanId] || [])
          .find(c => c.name === 'claude_code.tool.blocked_on_user')
        if (!blockedSpan) { return [toolEntry] }

        const blockedStart = nanoToMs(blockedSpan.startTime)
        const userInputEntry: TimelineEntry = {
          type: 'user_input' as const,
          spanId: blockedSpan.spanId,
          label: 'Permission prompt',
          turn: Math.max(1, turnCounter),
          durationMs: getAttrInt(blockedSpan, 'duration_ms') || (nanoToMs(blockedSpan.endTime) - blockedStart) || 0,
          decision: getAttrStr(blockedSpan, 'decision') || undefined,
          isError: false,
          timestamp: blockedStart > 0 ? new Date(blockedStart).toISOString() : ts,
        }
        return [toolEntry, userInputEntry]
      }
    })

    // Supplement file paths from claude_code.tool_result log-derived spans.
    // These arrive when OTEL_LOG_TOOL_DETAILS=1 and carry tool_input with actual paths.
    // Run this BEFORE computing filesChangedNote so the note reflects final state.
    const toolResultSpans = traceSpans.filter(s => s.name === 'claude_code.tool_result')
    for (const trs of toolResultSpans) {
      const trToolName = getAttrStr(trs, 'tool.name') || getAttrStr(trs, 'tool_name')
      const trArgsStr = getAttrStr(trs, 'tool_input') || getAttrStr(trs, 'input')
      if (!trToolName || !trArgsStr) { continue }
      let fp = ''
      let multiEdits: Array<{ file_path?: string; filePath?: string }> = []
      try {
        // tool_input may be a JSON args object or a bare file path string
        const args = JSON.parse(trArgsStr) as Record<string, unknown>
        fp = String(args.file_path || args.filePath || '')
        if (trToolName === 'MultiEdit' && Array.isArray(args.edits)) {
          multiEdits = args.edits as Array<{ file_path?: string; filePath?: string }>
        }
        if (!fp && trToolName !== 'MultiEdit') {
          // Structured args present but no file_path key — skip
        }
      } catch {
        // Not JSON: treat the raw string as the file path directly
        fp = trArgsStr.trim()
      }
      if (fp) {
        if (fp.startsWith('/')) { allAbsFilePaths.add(fp) }
        if (CLAUDE_WRITE_TOOLS.has(trToolName)) {
          filesChanged.add(fp)
          if (FULL_WRITE_TOOLS.has(trToolName)) filesWritten.add(fp)
        } else if (trToolName === 'Read') { filesRead.add(fp.split('/').pop() || fp) }
        else if (trToolName === 'Glob' || trToolName === 'Grep') { filesSearched.add(fp) }
      }
      for (const e of multiEdits) {
        const efp = e.file_path || e.filePath
        if (efp) {
          const efpStr = String(efp)
          if (efpStr.startsWith('/')) { allAbsFilePaths.add(efpStr) }
          filesChanged.add(efpStr)
        }
      }
    }

    // ── Log-derived rich Claude Code events (api_request / compaction / api_error) ────────────────
    // These arrive as OTEL LOG records (ingested by OtlpCollector.processLogs keyed by session.id)
    // and carry the per-call ground truth the llm_request SPANS lack: exact cost + WHO caused the
    // call (query_source / agent / skill / plugin / mcp). Each becomes its own timeline entry.
    // IMPORTANT: api_request tokens are deliberately NOT added to the session aggregate totals — the
    // llm_request spans already count them; adding them here would double-count the session.
    const richEventSpans = traceSpans.filter(s =>
      s.name === 'claude_code.api_request' ||
      s.name === 'claude_code.compaction' ||
      s.name === 'claude_code.api_error' ||
      s.name === 'claude_code.api_retries_exhausted'
    )
    for (const rs of richEventSpans) {
      const rsStart = nanoToMs(rs.startTime)
      const rsTs = rsStart > 0 ? new Date(rsStart).toISOString() : ''
      const rsDur = getAttrInt(rs, 'duration_ms') || (nanoToMs(rs.endTime) - rsStart) || 0
      const rsModel = getGenAiModel(rs)
      if (rs.name === 'claude_code.api_request') {
        // api_request events emit Anthropic-shaped usage (input cache-excluded) — same constructor,
        // same four disjoint buckets as every other entry.
        const rb = disjointBuckets(extractTokenCounts(rs), 'anthropic')
        const costStr = getAttrStr(rs, 'cost_usd')
        timeline.push({
          type: 'api_request' as const,
          spanId: rs.spanId,
          label: 'api_request',
          model: rsModel || undefined,
          inputTokens: rb.inputTokens || undefined,
          outputTokens: rb.outputTokens || undefined,
          cacheReadTokens: rb.cacheReadTokens || undefined,
          cacheCreateTokens: rb.cacheCreateTokens || undefined,
          costUsd: costStr ? Number(costStr) : undefined,
          querySource: getAttrStr(rs, 'query_source') || undefined,
          agentName: getAttrStr(rs, 'agent.name') || undefined,
          skillName: getAttrStr(rs, 'skill.name') || undefined,
          pluginName: getAttrStr(rs, 'plugin.name') || undefined,
          mcpServerName: getAttrStr(rs, 'mcp_server.name') || undefined,
          mcpToolName: getAttrStr(rs, 'mcp_tool.name') || undefined,
          requestId: getAttrStr(rs, 'request_id') || undefined,
          durationMs: rsDur,
          isError: false,
          timestamp: rsTs,
        })
      } else if (rs.name === 'claude_code.compaction') {
        timeline.push({
          type: 'compaction' as const,
          spanId: rs.spanId,
          label: 'compaction',
          compactionTrigger: getAttrStr(rs, 'trigger') || undefined,
          preTokens: getAttrInt(rs, 'pre_tokens') || undefined,
          postTokens: getAttrInt(rs, 'post_tokens') || undefined,
          durationMs: rsDur,
          isError: getAttrStr(rs, 'success') === 'false',
          timestamp: rsTs,
        })
      } else {
        // claude_code.api_error / claude_code.api_retries_exhausted
        errors++
        const statusStr = getAttrStr(rs, 'status_code')
        const attemptsStr = getAttrStr(rs, 'attempt') || getAttrStr(rs, 'total_attempts')
        timeline.push({
          type: 'api_error' as const,
          spanId: rs.spanId,
          label: rs.name === 'claude_code.api_retries_exhausted' ? 'api_retries_exhausted' : 'api_error',
          model: rsModel || undefined,
          statusCode: statusStr ? Number(statusStr) : undefined,
          attempts: attemptsStr ? Number(attemptsStr) : undefined,
          durationMs: rsDur,
          isError: true,
          errorMessage: getAttrStr(rs, 'error') || undefined,
          timestamp: rsTs,
        })
      }
    }
    // Re-order chronologically after appending the log-derived entries (timelineTsKey sends
    // timestamp-less entries last so a missing ISO string can't scramble the well-timed ones).
    timeline.sort((a, b) => timelineTsKey(a) - timelineTsKey(b))

    const workspace = findProjectRoot(commonPathPrefix([...allAbsFilePaths]))

    const startMs = nanoToMs(interaction.startTime)
    // The card's four disjoint buckets — sums of per-call disjoint buckets, routed through the one
    // constructor so the invariant is compile-shaped (a future incl-cache accumulator can't slip in).
    const buckets = disjointBuckets(
      { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheCreate: cacheCreateTokens },
      'anthropic',
    )
    const totalContext = contextTokens(buckets)
    const cacheHitRate = (totalContext > 0) ? buckets.cacheReadTokens / totalContext : 0
    const durationMs = getAttrInt(interaction, 'interaction.duration_ms')
      || (nanoToMs(interaction.endTime) - startMs)

    const rawPrompt = getAttrStr(interaction, 'user_prompt')
    const promptLength = getAttrInt(interaction, 'user_prompt_length')
    const hasData = totalLlmCalls > 0 || inputTokens > 0 || timeline.length > 0
    const userRequest = normalizeUserRequest(
      rawPrompt, promptLength,
      hasData ? '[prompt redacted]' : '[session in progress]',
      hasData ? 'prompt redacted' : 'session in progress',
    )

    // Note is computed AFTER enrichment — if enrichment found files, filesChanged.size > 0
    // and we suppress the note entirely. Only show it when zero paths were found.
    const filesChangedNote = (filesChanged.size === 0 && missingChangedFilePathCalls > 0)
      ? `Changed-file paths are unavailable for ${missingChangedFilePathCalls} write operation${missingChangedFilePathCalls !== 1 ? 's' : ''}. `
        + `Claude Code redacts tool arguments by default. Add OTEL_LOG_TOOL_DETAILS=1 to your Claude environment variables (alongside CLAUDE_CODE_ENABLE_TELEMETRY=1) and restart to enable path tracking.`
      : undefined

    return {
      sessionId: interaction.spanId,
      traceId: interaction.traceId || '',
      source: 'claude_code' as const,
      dataSource: 'otel' as const,
      initiator: (interaction.parentSpanId || getAttrStr(interaction, 'is_sidechain') === 'true') ? 'agent' as const : 'user' as const,
      // TRDD-BURNWDGT — the OAuth account for this OTEL session: prefer the span's user.account_uuid
      // attribute, else the shared registry keyed by the Claude Code session.id. account_uuid is an
      // identifier, not a secret; undefined when unknown (fail-soft).
      accountId: getAttrStr(interaction, 'user.account_uuid')
        || callBodyRegistry.accountFor(getAttrStr(interaction, 'session.id'))
        || undefined,
      workspace,
      userRequest,
      model,
      turns: totalLlmCalls,
      // RAW uncached input — the schema invariant is FOUR DISJOINT BUCKETS (calcTokenCostUsd bills
      // each at its own rate), enforced by disjointBuckets() above. This card stored the incl-cache
      // total until 2026-07-10, which (a) double-billed every cache token at the full input rate in
      // the write-time cost, and (b) made the same session read up to ~1000× apart between the OTEL
      // and log feeds. The incl-cache total lives on only inside cacheHitRate above.
      inputTokens: buckets.inputTokens,
      outputTokens: buckets.outputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheCreateTokens: buckets.cacheCreateTokens,
      cacheHitRate,
      durationMs,
      startTime: startMs > 0 ? new Date(startMs).toISOString() : '',
      filesRead: Array.from(filesRead),
      filesSearched: Array.from(filesSearched),
      filesChanged: Array.from(filesChanged),
      filesWritten: Array.from(filesWritten),
      filesChangedNote,
      toolCounts,
      totalToolCalls,
      totalLlmCalls,
      errors,
      outcome: 'unknown' as const,
      timeline,
      backgroundSpans: [],
      loopSignals: [],
    }
}
