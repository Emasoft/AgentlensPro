//! Port of src/logReader.ts's per-source log-file DISCOVERY (TRDD-DMWOBWFH P5a): where each
//! agent writes its session logs, the env overrides, and the walk that lists them. Parsing is
//! the sibling modules; this module only answers "which files are sessions".
//!
//! Mirrored verbatim from the TS (the roots comment block at the top of logReader.ts):
//!   Claude Code  <CLAUDE_CONFIG_DIR|~/.claude>/projects/**/*.jsonl   (XDG_CONFIG_HOME/claude too;
//!                Windows %APPDATA%\Claude\projects)
//!   Codex        <CODEX_HOME|~/.codex>/sessions/**/*.jsonl         (Windows %LOCALAPPDATA%/%APPDATA%)
//!   Copilot CLI  ~/.copilot/session-state/<uuid>/events.jsonl       (Windows %APPDATA%\copilot)
//!   Copilot Chat <IDE>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl|.json — a .json is
//!                a session only when no .jsonl sibling shares its uuid
//!   OpenCode     <OPENCODE_DATA_DIR|$XDG_DATA_HOME/opencode|~/.local/share/opencode>/opencode.db
//!
//! Testability: every root resolver takes an `Env` (home + platform + the variables it reads)
//! instead of touching the process environment, so a fixture tree pins the rules.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The VS Code-family IDEs whose workspaceStorage hosts Copilot Chat sessions
/// (src/vscodeFamilyIdes.ts — keep the two lists identical).
pub const VSCODE_FAMILY_IDE_NAMES: [&str; 7] = ["Code", "Code - Insiders", "Cursor", "Windsurf", "VSCodium", "Trae", "Kiro"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Platform {
    Win32,
    Darwin,
    Other,
}

/// The slice of the process environment discovery reads.
#[derive(Clone, Debug)]
pub struct Env {
    pub home: PathBuf,
    pub platform: Platform,
    pub vars: HashMap<String, String>,
}

impl Env {
    /// The real process environment.
    pub fn from_process() -> Env {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let platform = if cfg!(target_os = "windows") {
            Platform::Win32
        } else if cfg!(target_os = "macos") {
            Platform::Darwin
        } else {
            Platform::Other
        };
        let vars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_DATA_DIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_owned(), v)))
            .collect();
        Env { home, platform, vars }
    }

    fn var(&self, k: &str) -> Option<&str> {
        self.vars.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }

    /// `env.split(',').map(trim).filter(Boolean)` — the comma-list override shape.
    fn list(&self, k: &str) -> Option<Vec<String>> {
        self.var(k).map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect())
    }
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// claudeProjectsDirs — CLAUDE_CONFIG_DIR list (each suffixed `projects` unless it already ends
/// with it, NOT existence-filtered — the TS returns the override list as-is), else the
/// existence-filtered platform candidates.
pub fn claude_projects_dirs(env: &Env) -> Vec<PathBuf> {
    if let Some(list) = env.list("CLAUDE_CONFIG_DIR") {
        return list
            .into_iter()
            .map(|p| if p.ends_with("projects") { PathBuf::from(p) } else { Path::new(&p).join("projects") })
            .collect();
    }
    let mut candidates: Vec<PathBuf> = vec![env.home.join(".claude").join("projects")];
    if env.platform == Platform::Win32 {
        if let Some(app) = env.var("APPDATA") {
            candidates.insert(0, Path::new(app).join("Claude").join("projects"));
        }
    } else if let Some(xdg) = env.var("XDG_CONFIG_HOME") {
        candidates.push(Path::new(xdg).join("claude").join("projects"));
    }
    candidates.into_iter().filter(|d| is_dir(d)).collect()
}

/// codexSessionsDirs — CODEX_HOME list (each + `sessions`, unfiltered), else the platform
/// candidates (LOCALAPPDATA/APPDATA on Windows, then ~/.codex/sessions), existence-filtered.
pub fn codex_sessions_dirs(env: &Env) -> Vec<PathBuf> {
    if let Some(list) = env.list("CODEX_HOME") {
        return list.into_iter().map(|p| Path::new(&p).join("sessions")).collect();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if env.platform == Platform::Win32 {
        if let Some(local) = env.var("LOCALAPPDATA") {
            candidates.push(Path::new(local).join("Codex").join("sessions"));
        }
        if let Some(app) = env.var("APPDATA") {
            candidates.push(Path::new(app).join("Codex").join("sessions"));
        }
    }
    candidates.push(env.home.join(".codex").join("sessions"));
    candidates.into_iter().filter(|d| is_dir(d)).collect()
}

/// openCodeDataDirs — OPENCODE_DATA_DIR list (existence-FILTERED, unlike the other overrides),
/// else %APPDATA%\opencode or $XDG_DATA_HOME/opencode (~/.local/share/opencode).
pub fn opencode_data_dirs(env: &Env) -> Vec<PathBuf> {
    if let Some(list) = env.list("OPENCODE_DATA_DIR") {
        return list.into_iter().map(PathBuf::from).filter(|d| is_dir(d)).collect();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if env.platform == Platform::Win32 {
        if let Some(app) = env.var("APPDATA") {
            candidates.push(Path::new(app).join("opencode"));
        }
    } else {
        let xdg_data = env.var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| env.home.join(".local").join("share"));
        candidates.push(xdg_data.join("opencode"));
    }
    candidates.into_iter().filter(|d| is_dir(d)).collect()
}

/// copilotSessionStateDir — the FIRST existing of %APPDATA%\copilot\session-state (Windows)
/// then ~/.copilot/session-state.
pub fn copilot_session_state_dir(env: &Env) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if env.platform == Platform::Win32 {
        if let Some(app) = env.var("APPDATA") {
            candidates.push(Path::new(app).join("copilot").join("session-state"));
        }
    }
    candidates.push(env.home.join(".copilot").join("session-state"));
    candidates.into_iter().find(|d| is_dir(d))
}

/// vscodeFamilyWorkspaceStorageRoots — every existing `<IDE>/User/workspaceStorage` across the
/// family, per platform.
pub fn vscode_family_workspace_storage_roots(env: &Env) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for name in VSCODE_FAMILY_IDE_NAMES {
        match env.platform {
            Platform::Win32 => {
                if let Some(app) = env.var("APPDATA") {
                    candidates.push(Path::new(app).join(name).join("User").join("workspaceStorage"));
                }
            }
            Platform::Darwin => {
                candidates.push(env.home.join("Library").join("Application Support").join(name).join("User").join("workspaceStorage"));
            }
            Platform::Other => {
                let xdg = env.var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| env.home.join(".config"));
                candidates.push(xdg.join(name).join("User").join("workspaceStorage"));
            }
        }
    }
    candidates.into_iter().filter(|d| is_dir(d)).collect()
}

/// _collectJsonlFiles — recursive walk, readdir order, `.jsonl` regular files only; an
/// unreadable directory contributes nothing (never an error).
pub fn collect_jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for entry in rd.flatten() {
        let full = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            out.extend(collect_jsonl_files(&full));
        } else if ft.is_file() && full.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(full);
        }
    }
    out
}

/// One discovered session file and the grammar that parses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogSource {
    Claude,
    Codex,
    CopilotCli,
    CopilotVscode,
    CopilotVscodeJson,
    OpenCodeDb,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredFile {
    pub source: LogSource,
    pub path: PathBuf,
}

/// Every session log the TS LogReader would scan, in its scan order: claude → codex → copilot
/// CLI → copilot VS Code (jsonl, then json-without-jsonl-sibling) → opencode dbs.
pub fn discover_all(env: &Env) -> Vec<DiscoveredFile> {
    let mut out: Vec<DiscoveredFile> = Vec::new();
    for d in claude_projects_dirs(env) {
        out.extend(collect_jsonl_files(&d).into_iter().map(|path| DiscoveredFile { source: LogSource::Claude, path }));
    }
    for d in codex_sessions_dirs(env) {
        out.extend(collect_jsonl_files(&d).into_iter().map(|path| DiscoveredFile { source: LogSource::Codex, path }));
    }
    if let Some(state_dir) = copilot_session_state_dir(env) {
        if let Ok(rd) = std::fs::read_dir(&state_dir) {
            for entry in rd.flatten() {
                let events = entry.path().join("events.jsonl");
                // statSync-gated: an absent events.jsonl is not a session.
                if std::fs::metadata(&events).is_ok() {
                    out.push(DiscoveredFile { source: LogSource::CopilotCli, path: events });
                }
            }
        }
    }
    for root in vscode_family_workspace_storage_roots(env) {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for hash_dir in rd.flatten() {
            let chat_dir = hash_dir.path().join("chatSessions");
            let Ok(names) = std::fs::read_dir(&chat_dir) else { continue };
            let names: Vec<String> = names.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            let jsonl_ids: std::collections::HashSet<&str> =
                names.iter().filter(|n| n.ends_with(".jsonl")).map(|n| &n[..n.len() - 6]).collect();
            for name in &names {
                if name.ends_with(".jsonl") {
                    out.push(DiscoveredFile { source: LogSource::CopilotVscode, path: chat_dir.join(name) });
                } else if name.ends_with(".json") && !jsonl_ids.contains(&name[..name.len() - 5]) {
                    out.push(DiscoveredFile { source: LogSource::CopilotVscodeJson, path: chat_dir.join(name) });
                }
            }
        }
    }
    for d in opencode_data_dirs(env) {
        let db = d.join("opencode.db");
        if std::fs::metadata(&db).is_ok() {
            out.push(DiscoveredFile { source: LogSource::OpenCodeDb, path: db });
        }
    }
    out
}
