//! Log-file discovery against a FIXTURE tree (TRDD-DMWOBWFH P5a): every root rule, every env
//! override shape (list overrides are NOT existence-filtered except OPENCODE_DATA_DIR — the
//! TS asymmetry, kept), the .json-without-.jsonl-sibling rule, the events.jsonl stat gate, the
//! per-platform roots, and the scan order.

use agentlens_logscan::discovery::*;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-disc-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn touch(p: &Path) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, b"{}\n").unwrap();
}

fn env(home: &Path, platform: Platform, vars: &[(&str, &str)]) -> Env {
    Env { home: home.to_path_buf(), platform, vars: vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect::<HashMap<_, _>>() }
}

#[test]
fn darwin_defaults_discover_every_source_in_scan_order() {
    let home = tmp("darwin");
    touch(&home.join(".claude/projects/-Users-x-proj/abc.jsonl"));
    touch(&home.join(".claude/projects/-Users-x-proj/abc/subagents/agent-1.jsonl"));
    touch(&home.join(".claude/projects/-Users-x-proj/notes.txt")); // ignored
    touch(&home.join(".codex/sessions/2026/08/19/rollout.jsonl"));
    touch(&home.join(".copilot/session-state/s1/events.jsonl"));
    fs::create_dir_all(home.join(".copilot/session-state/s2-no-events")).unwrap(); // stat-gated out
    touch(&home.join("Library/Application Support/Code/User/workspaceStorage/h1/chatSessions/u1.jsonl"));
    touch(&home.join("Library/Application Support/Code/User/workspaceStorage/h1/chatSessions/u1.json")); // sibling → skipped
    touch(&home.join("Library/Application Support/Cursor/User/workspaceStorage/h2/chatSessions/u2.json")); // legacy → kept
    touch(&home.join(".local/share/opencode/opencode.db"));
    let e = env(&home, Platform::Darwin, &[]);
    let found = discover_all(&e);
    let rel: Vec<(LogSource, String)> = found
        .iter()
        .map(|f| (f.source.clone(), f.path.strip_prefix(&home).unwrap().to_string_lossy().into_owned()))
        .collect();
    // Claude (walk order within a dir is readdir order — sort those two for a stable assert).
    let claude: Vec<&String> = rel.iter().filter(|(s, _)| *s == LogSource::Claude).map(|(_, p)| p).collect();
    assert_eq!(claude.len(), 2, "{rel:?}");
    assert!(claude.iter().any(|p| p.ends_with("abc.jsonl")) && claude.iter().any(|p| p.ends_with("agent-1.jsonl")));
    let rest: Vec<(LogSource, String)> = rel.iter().filter(|(s, _)| *s != LogSource::Claude).cloned().collect();
    assert_eq!(
        rest,
        vec![
            (LogSource::Codex, ".codex/sessions/2026/08/19/rollout.jsonl".to_owned()),
            (LogSource::CopilotCli, ".copilot/session-state/s1/events.jsonl".to_owned()),
            (LogSource::CopilotVscode, "Library/Application Support/Code/User/workspaceStorage/h1/chatSessions/u1.jsonl".to_owned()),
            (LogSource::CopilotVscodeJson, "Library/Application Support/Cursor/User/workspaceStorage/h2/chatSessions/u2.json".to_owned()),
            (LogSource::OpenCodeDb, ".local/share/opencode/opencode.db".to_owned()),
        ]
    );
    // Scan order: claude first, opencode last.
    assert_eq!(found.first().unwrap().source, LogSource::Claude);
    assert_eq!(found.last().unwrap().source, LogSource::OpenCodeDb);
}

#[test]
fn env_overrides_follow_the_ts_shapes() {
    let home = tmp("env");
    let alt = tmp("env-alt");
    touch(&alt.join("projects/p/one.jsonl"));
    fs::create_dir_all(alt.join("codexhome/sessions")).unwrap();
    // CLAUDE_CONFIG_DIR: comma list, `projects` appended unless already the leaf, NOT filtered.
    let e = env(&home, Platform::Other, &[("CLAUDE_CONFIG_DIR", &format!("{} , {}/projects, ", alt.display(), alt.display()))]);
    let dirs = claude_projects_dirs(&e);
    assert_eq!(dirs, vec![alt.join("projects"), alt.join("projects")]);
    // CODEX_HOME: each + sessions, unfiltered even when missing.
    let e = env(&home, Platform::Other, &[("CODEX_HOME", &format!("{}/codexhome,{}/missing", alt.display(), alt.display()))]);
    assert_eq!(codex_sessions_dirs(&e), vec![alt.join("codexhome/sessions"), alt.join("missing/sessions")]);
    // OPENCODE_DATA_DIR: existence-FILTERED.
    let e = env(&home, Platform::Other, &[("OPENCODE_DATA_DIR", &format!("{}/codexhome,{}/missing", alt.display(), alt.display()))]);
    assert_eq!(opencode_data_dirs(&e), vec![alt.join("codexhome")]);
    // XDG on Linux: claude gets XDG_CONFIG_HOME/claude/projects appended; opencode uses XDG_DATA_HOME.
    let xdgc = tmp("xdgc");
    let xdgd = tmp("xdgd");
    touch(&xdgc.join("claude/projects/p/a.jsonl"));
    touch(&xdgd.join("opencode/opencode.db"));
    let e = env(&home, Platform::Other, &[("XDG_CONFIG_HOME", &xdgc.to_string_lossy()), ("XDG_DATA_HOME", &xdgd.to_string_lossy())]);
    assert_eq!(claude_projects_dirs(&e), vec![xdgc.join("claude/projects")]); // ~/.claude absent → filtered
    assert_eq!(opencode_data_dirs(&e), vec![xdgd.join("opencode")]);
    assert_eq!(vscode_family_workspace_storage_roots(&e), Vec::<PathBuf>::new());
}

#[test]
fn win32_roots_use_appdata_and_localappdata_in_the_ts_precedence() {
    let home = tmp("win-home");
    let app = tmp("win-appdata");
    let local = tmp("win-local");
    touch(&app.join("Claude/projects/p/a.jsonl"));
    touch(&home.join(".claude/projects/p/b.jsonl"));
    fs::create_dir_all(local.join("Codex/sessions")).unwrap();
    fs::create_dir_all(app.join("Codex/sessions")).unwrap();
    fs::create_dir_all(home.join(".codex/sessions")).unwrap();
    fs::create_dir_all(app.join("copilot/session-state")).unwrap();
    fs::create_dir_all(home.join(".copilot/session-state")).unwrap();
    fs::create_dir_all(app.join("Windsurf/User/workspaceStorage")).unwrap();
    fs::create_dir_all(app.join("opencode")).unwrap();
    let e = env(&home, Platform::Win32, &[("APPDATA", &app.to_string_lossy()), ("LOCALAPPDATA", &local.to_string_lossy())]);
    // APPDATA first (unshift), then ~/.claude.
    assert_eq!(claude_projects_dirs(&e), vec![app.join("Claude/projects"), home.join(".claude/projects")]);
    assert_eq!(codex_sessions_dirs(&e), vec![local.join("Codex/sessions"), app.join("Codex/sessions"), home.join(".codex/sessions")]);
    assert_eq!(copilot_session_state_dir(&e), Some(app.join("copilot/session-state")));
    assert_eq!(vscode_family_workspace_storage_roots(&e), vec![app.join("Windsurf/User/workspaceStorage")]);
    assert_eq!(opencode_data_dirs(&e), vec![app.join("opencode")]);
}

#[test]
fn collect_jsonl_files_recurses_and_ignores_unreadable_or_non_jsonl() {
    let root = tmp("walk");
    touch(&root.join("a/b/c.jsonl"));
    touch(&root.join("a/d.jsonl"));
    touch(&root.join("a/e.json"));
    touch(&root.join("f.JSONL")); // case-sensitive like the TS endsWith
    let mut got: Vec<String> = collect_jsonl_files(&root).iter().map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().into_owned()).collect();
    got.sort();
    assert_eq!(got, vec!["a/b/c.jsonl", "a/d.jsonl"]);
    assert!(collect_jsonl_files(Path::new("/definitely/not/here")).is_empty());
}
