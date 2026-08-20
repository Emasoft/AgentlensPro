//! The MCP endpoint (TRDD-DMWOBWFH P4x) — JSON-RPC over POST /mcp.
//!
//! SCOPE, stated plainly because it is narrower than "MCP support": the TS server wraps the SDK's
//! `StreamableHTTPServerTransport`, but the ONLY shipped consumer is this repo's own CLI
//! (`src/cli/cliCore.ts`), which sends a plain JSON-RPC body and explicitly accepts EITHER an SSE
//! frame OR plain JSON back ("The transport may answer as SSE or as plain JSON"). It uses exactly
//! three methods: `initialize`, `tools/list`, `tools/call`. So this serves plain JSON for those
//! three. That is sufficient for the CLI and is NOT full Streamable-HTTP compliance — a general MCP
//! client (session ids, SSE streaming, resumability) would need more. The CLAUDE.md note that the
//! MCP server is deliberately NOT registered with Claude Code is what makes that trade safe today;
//! if it is ever registered, this becomes insufficient and must be revisited.
//!
//! The 53 tool SCHEMAS are a FROZEN wire surface the CLI reads live, so they are not transcribed:
//! `assets/mcp-tools.json` is GENERATED from the TS `TOOLS` array and embedded verbatim. ~1,200
//! lines of schema data is precisely what a hand port gets subtly wrong.
//! Regenerate with:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/assets/gen-mcp-tools.mjs

use serde_json::{Map, Value};
use std::sync::OnceLock;

/// The generated schema asset, embedded at compile time so the binary is self-contained.
const TOOLS_JSON: &str = include_str!("../assets/mcp-tools.json");

/// Parsed once. A malformed asset is a BUILD-TIME authoring error, not a runtime condition, so
/// this panics loudly rather than serving an empty tool list — an empty `tools/list` would make
/// every CLI command fail with "unknown tool", which reads like a user error rather than a broken
/// build.
pub fn tools() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| {
        let v: Value = serde_json::from_str(TOOLS_JSON).expect("assets/mcp-tools.json is valid JSON");
        assert!(
            v.get("tools").and_then(Value::as_array).is_some_and(|t| !t.is_empty()),
            "assets/mcp-tools.json must carry a non-empty `tools` array"
        );
        v
    })
}

fn result(id: Option<&Value>, result: Value) -> Value {
    let mut m = Map::new();
    m.insert("jsonrpc".into(), Value::String("2.0".into()));
    m.insert("id".into(), id.cloned().unwrap_or(Value::Null));
    m.insert("result".into(), result);
    Value::Object(m)
}

fn error(id: Option<&Value>, code: i64, message: &str) -> Value {
    let mut e = Map::new();
    e.insert("code".into(), Value::from(code));
    e.insert("message".into(), Value::String(message.to_owned()));
    let mut m = Map::new();
    m.insert("jsonrpc".into(), Value::String("2.0".into()));
    m.insert("id".into(), id.cloned().unwrap_or(Value::Null));
    m.insert("error".into(), Value::Object(e));
    Value::Object(m)
}

/// Wrap a tool's payload in the MCP content envelope the CLI unwraps (`textOf` reads
/// `content[0].text` and JSON-parses it).
pub fn tool_text_result(payload: &Value) -> Value {
    let mut c = Map::new();
    c.insert("type".into(), Value::String("text".into()));
    c.insert("text".into(), Value::String(serde_json::to_string(payload).unwrap_or_default()));
    let mut m = Map::new();
    m.insert("content".into(), Value::Array(vec![Value::Object(c)]));
    Value::Object(m)
}

/// Is `name` one of the frozen tools?
pub fn tool_exists(name: &str) -> bool {
    tools()["tools"]
        .as_array()
        .is_some_and(|ts| ts.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)))
}

/// Dispatch one JSON-RPC request. `call` is the tool implementation hook: it returns the tool's
/// payload, or None when that tool is not ported yet.
pub fn handle_rpc(body: &Value, call: &dyn Fn(&str, &Value) -> Option<Value>) -> Value {
    let id = body.get("id");
    let Some(method) = body.get("method").and_then(Value::as_str) else {
        return error(id, -32600, "invalid request: no method");
    };
    match method {
        // The CLI ignores this result and only awaits it, but the shape is the documented one so a
        // stricter client is not immediately broken.
        "initialize" => {
            let mut m = Map::new();
            m.insert("protocolVersion".into(), Value::String("2024-11-05".into()));
            let mut caps = Map::new();
            caps.insert("tools".into(), Value::Object(Map::new()));
            m.insert("capabilities".into(), Value::Object(caps));
            let mut info = Map::new();
            info.insert("name".into(), Value::String("agentlenspro".into()));
            info.insert("version".into(), Value::String(env!("CARGO_PKG_VERSION").to_owned()));
            m.insert("serverInfo".into(), Value::Object(info));
            result(id, Value::Object(m))
        }
        "tools/list" => result(id, tools().clone()),
        "tools/call" => {
            let params = body.get("params");
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return error(id, -32602, "invalid params: tools/call needs a tool name");
            };
            let empty = Value::Object(Map::new());
            let args = params.and_then(|p| p.get("arguments")).unwrap_or(&empty);
            if !tool_exists(name) {
                return error(id, -32601, &format!("unknown tool: {name}"));
            }
            match call(name, args) {
                Some(payload) => result(id, tool_text_result(&payload)),
                // A tool that EXISTS in the frozen schema but has no Rust implementation yet must
                // say exactly that. Returning an empty result instead would look like a working
                // tool that found nothing — the worst possible failure for a diagnostic.
                None => error(id, -32601, &format!("tool {name} is not yet implemented in the Rust core (agentlens-core); it is still served by the TypeScript MCP server")),
            }
        }
        // Notifications carry no id and expect no response body; answering with a result is
        // harmless for this endpoint and keeps the handler total.
        other => error(id, -32601, &format!("unknown method: {other}")),
    }
}
