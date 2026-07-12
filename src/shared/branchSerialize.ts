// Pure, runtime-neutral serializer for a session/subagent branch → a fully-expanded
// TEXT tree for the "copy branch" dashboard button (TRDD-4CH9QLAH, Phase 3).
//
// WHY this lives in src/shared/: it is imported by BOTH the webview (media/src/CopyBranchButton.tsx)
// AND the mocha suite (src/test/branchSerialize.test.ts). Keeping it here — with zero Node imports
// and zero DOM APIs — lets the 911-suite test the tree logic while the webview reuses the exact
// same code, satisfying the anti-mirror doctrine (scripts/check-no-mirrors.js). The async part
// (loading lazy descendants, fetching blobs, POSTing dumps, writing the clipboard) stays webview-side;
// this module only turns already-materialized node data into text + a list of over-threshold dumps.

/** OTEL↔JSONL correlation ids attached to a node. Any subset may be present. */
export interface SerialMatchKey {
  spanId?: string;
  requestId?: string;
  traceId?: string;
}

/** One labelled content section of a node (e.g. thinking / response / tool input / result / error). */
export interface SerialBody {
  label: string;
  text: string;
}

/** A node in the branch: a session, an llm turn, a tool call, or another timeline event. */
export interface SerialNode {
  kind: 'session' | 'llm' | 'tool' | 'event';
  /** One-line header for the node, already formatted by the caller (label · model · tokens · cost). */
  title: string;
  /** Correlation ids — printed as a grep-able match-key suffix on the title line when present. */
  match?: SerialMatchKey;
  bodies?: SerialBody[];
  children?: SerialNode[];
}

/** Top-of-dump provenance header. */
export interface SerialHeader {
  sessionId: string;
  slug: string;
  source?: string;
  dataSource?: string;
}

/** An over-threshold body extracted for out-of-line dumping. Referenced in `text` as `@@DUMP:id@@`. */
export interface DumpEntry {
  id: string;
  /** Suggested filename stem (sanitized further by the server). */
  name: string;
  content: string;
}

export interface SerializeOptions {
  /** Bodies larger than this (UTF-8 bytes) become a dump placeholder instead of inline text. */
  thresholdBytes?: number;
}

export interface SerializeResult {
  /** The tree text. Over-threshold body sections appear as `@@DUMP:<id>@@`; the caller replaces
   *  each placeholder with the real dump-file path returned by POST /api/branch-dump. */
  text: string;
  dumps: DumpEntry[];
}

export const DEFAULT_THRESHOLD_BYTES = 8192;
const RULE = '─'.repeat(60);

// TextEncoder is a global in both Node 18+ and every browser, so byte-length is runtime-neutral.
// We threshold on BYTES (the honest "how big is this output" measure) but report CHARS to the human.
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

function matchSuffix(m?: SerialMatchKey): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.spanId) parts.push(`span=${m.spanId}`);
  if (m.requestId) parts.push(`req=${m.requestId}`);
  if (m.traceId) parts.push(`trace=${m.traceId}`);
  return parts.length ? `  ⟨${parts.join(' ')}⟩` : '';
}

interface RenderState {
  lines: string[];
  dumps: DumpEntry[];
  counter: { n: number };
  threshold: number;
}

// Render one body section under `bodyPrefix`. Inline when small; a single dump placeholder when large.
function renderBody(b: SerialBody, bodyPrefix: string, st: RenderState): void {
  const text = b.text ?? '';
  if (utf8Bytes(text) > st.threshold) {
    const id = `d${++st.counter.n}`;
    // name is a stem; the server sanitizes + timestamps it. Keep it label-derived and safe-ish.
    const name = b.label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'output';
    st.dumps.push({ id, name, content: text });
    st.lines.push(`${bodyPrefix}${b.label}: [${text.length} chars → dump: @@DUMP:${id}@@]`);
    return;
  }
  const parts = text.split('\n');
  st.lines.push(`${bodyPrefix}${b.label}: ${parts[0]}`);
  // Continuation lines align under the text, keeping the same guide prefix.
  const contPrefix = bodyPrefix + ' '.repeat(b.label.length + 2);
  for (let i = 1; i < parts.length; i++) st.lines.push(`${contPrefix}${parts[i]}`);
}

function renderNode(node: SerialNode, prefix: string, isLast: boolean, isRoot: boolean, st: RenderState): void {
  const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
  const bullet = node.kind === 'session' ? '● ' : node.kind === 'llm' ? '' : node.kind === 'tool' ? '' : '';
  st.lines.push(`${prefix}${connector}${bullet}${node.title}${matchSuffix(node.match)}`);

  // Where this node's own content + children render: extend the prefix past our connector.
  const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
  const bodyPrefix = `${childPrefix}  `;
  for (const b of node.bodies ?? []) renderBody(b, bodyPrefix, st);

  const kids = node.children ?? [];
  kids.forEach((k, i) => renderNode(k, childPrefix, i === kids.length - 1, false, st));
}

/**
 * Serialize a fully-materialized branch to a self-describing text tree + a list of over-threshold
 * dumps. Pure: no I/O, no clock (the caller stamps dump filenames). The returned `text` carries
 * `@@DUMP:<id>@@` placeholders that the caller replaces with real file paths after the dump write.
 */
export function serializeBranch(header: SerialHeader, root: SerialNode, opts: SerializeOptions = {}): SerializeResult {
  const threshold = opts.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const st: RenderState = { lines: [], dumps: [], counter: { n: 0 }, threshold };

  const provenance = [
    `source: ${header.source ?? 'unknown'}${header.dataSource ? `/${header.dataSource}` : ''}`,
  ].join('   ');
  st.lines.push('# AgentlensPro branch dump');
  st.lines.push(`# session: ${header.sessionId}   project: ${header.slug}   ${provenance}`);
  st.lines.push('# match keys ⟨span=… req=… trace=…⟩ per node — grep the OTEL bodies dir / *.request.json to find the raw call');
  st.lines.push(RULE);

  renderNode(root, '', true, true, st);

  return { text: st.lines.join('\n') + '\n', dumps: st.dumps };
}
