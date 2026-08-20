// Generates mcp-tools.json — the 53 frozen MCP tool schemas — from the COMPILED TS mcpServer.js.
// The Rust core SERVES this asset verbatim from tools/list, so the frozen schema surface is
// byte-identical by construction instead of by hand-transcription (~1,200 lines of schema data is
// exactly what a manual port gets subtly wrong, and the CLI reads these schemas LIVE).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-mcp-tools.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { TOOLS } = require('../../../../out/test/mcpServer.js')
const dir = new URL('.', import.meta.url).pathname
if (!Array.isArray(TOOLS) || TOOLS.length === 0) throw new Error('TOOLS is not a non-empty array')
writeFileSync(join(dir, 'mcp-tools.json'), JSON.stringify({ tools: TOOLS }, null, 1))
console.log(`mcp-tools.json: ${TOOLS.length} tools`)
