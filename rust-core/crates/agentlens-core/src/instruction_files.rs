//! Instruction-file detection and I/O (TRDD-DMWOBWFH rows 19–21) — ports
//! src/instructionFiles.ts: CLAUDE.md (+ the .claude/ alternate), .github/
//! copilot-instructions.md, AGENTS.md.
//!
//! NOT PORTED: `removeSuggestion` — no route or tool consumes it (verified by grep across
//! src/ + standalone/); it exists for the dashboard's future undo affordance and stays TS-only
//! until something on this side needs it.

use std::path::Path;

use serde_json::{json, Value};

/// INSTRUCTION_FILE_DEFS — (agent, label, primary relative path, alternates).
const DEFS: [(&str, &str, &str, &[&str]); 3] = [
    ("claude_code", "Claude Code", "CLAUDE.md", &[".claude/CLAUDE.md"]),
    ("copilot", "GitHub Copilot", ".github/copilot-instructions.md", &[]),
    ("codex", "Codex", "AGENTS.md", &[]),
];

/// detectInstructionFiles — primary path first, then alternates; a missing file reports the
/// PRIMARY path with exists:false (the dashboard's create affordance). Wire shape per row:
/// `{agent, label, filePath, relativePath, exists, content}`.
pub fn detect_instruction_files(workspace_root: &str) -> Vec<Value> {
    DEFS.iter()
        .map(|(agent, label, primary, alternates)| {
            for rel in std::iter::once(primary).chain(alternates.iter()) {
                let abs = Path::new(workspace_root).join(rel);
                if abs.exists() {
                    // readFileSync('utf8') decodes lossily; a read error leaves content ''.
                    let content = std::fs::read(&abs).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                    return json!({
                        "agent": agent, "label": label,
                        "filePath": abs.to_string_lossy(),
                        "relativePath": rel,
                        "exists": true,
                        "content": content,
                    });
                }
            }
            json!({
                "agent": agent, "label": label,
                "filePath": Path::new(workspace_root).join(primary).to_string_lossy(),
                "relativePath": primary,
                "exists": false,
                "content": "",
            })
        })
        .collect()
}

/// appendSuggestion — append a marked block, creating the file (and directory) if absent. The
/// marker's date is today (UTC, the ISO date prefix), so removal-by-id stays greppable.
pub fn append_suggestion(file_path: &Path, text: &str, label: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file_path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir)?;
        }
    }
    let date = &crate::summarize::helpers::iso_from_ms(crate::now_ms() as f64)[..10];
    let block = format!("\n\n<!-- AgentLens suggestion applied {date} id:{label} -->\n{text}\n");
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(file_path)?;
    f.write_all(block.as_bytes())
}

/// Node `path.resolve` for the apply route's escape guard: absolutize against the process cwd,
/// then normalize `.`/`..` LEXICALLY (resolve never touches the filesystem). ParentDir at the
/// root stays at the root, as in Node.
pub fn resolve_lexical(p: &str) -> std::path::PathBuf {
    let abs = if Path::new(p).is_absolute() {
        std::path::PathBuf::from(p)
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut out = std::path::PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// readAllInstructionContent — the concatenated content of every EXISTING instruction file
/// (the advisor's already-mentioned filter reads this).
pub fn read_all_instruction_content(workspace_root: &str) -> String {
    detect_instruction_files(workspace_root)
        .iter()
        .filter(|f| f.get("exists") == Some(&Value::Bool(true)))
        .filter_map(|f| f.get("content").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>()
        .join("\n")
}
