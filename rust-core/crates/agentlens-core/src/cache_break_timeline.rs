//! Port of `src/cacheBreakTimeline.ts` SLICE 1 of 4 (TS lines 48-635, TRDD-DMWOBWFH P4x.2i) — the
//! cache-break ROOT-CAUSE classification PRIMITIVES: the cause taxonomy and its remediation table,
//! the per-model minimum cacheable length, the injected-content classifier, the segmenter, and
//! `extract_turn_prefix`, which reduces a multi-MB raw request body to a compact POINTER-ONLY
//! prefix — hashes, kinds, labels and counts, never block text and never base64.
//!
//! Slices 2-4 (the verdict engine, the timeline builder, the two report shapers) consume what is
//! here; everything they need is `pub`.
//!
//! ── JS→Rust regex translation, and where the two ENGINES genuinely differ ────────────────────
//! The `regex` crate has no lookaround, so two constructs are reproduced by hand:
//!   * `opus-4(?![-.\d])` → `opus-4($|[^-.0-9])`. Equivalent for a boolean `.test`: an occurrence
//!     exists that is not followed by one of those characters iff it is at end-of-input or the
//!     next character is outside the class. Dropping the lookahead instead would make
//!     `claude-opus-4-20250514` report 1024 — and would still pass every other model in the
//!     fixture, which is why the fixture carries that exact id.
//!   * `# Environment…[\s\S]*?(?=\n# |$)` → `extract_env_region`, which locates the anchor and
//!     stops at the first `\n# ` at or after it. A lazy match with a lookahead ends exactly there.
//!
//! Mechanical, house-style: JS `.` → `[^\n\r\u{2028}\u{2029}]` (JS excludes all four line
//! terminators; Rust's `.` excludes only `\n`), JS `\b` → `(?-u:\b)` (JS word chars are ASCII).
//!
//! TWO documented divergences, both narrow, neither reachable from the data these run on:
//!   1. `{0,80}` / `{0,300}` bounded gaps count UTF-16 CODE UNITS in JS and Unicode SCALARS here,
//!      so an astral character inside such a gap makes this port slightly more permissive (one
//!      unit here, two there). Every one of those gaps is a filesystem path or a compaction
//!      preamble; a 300-char path of emoji is not a case this classifier can meet.
//!   2. `(?m)^` anchors after `\n` here and after any of the four line terminators in JS.
//!
//! Both are stated rather than silently absorbed: a port that claims exactness it does not have is
//! worse than one that names its edges.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::summarize::helpers::{fmt_js_num, js_string, truthy, utf16_len};
use crate::token_estimator::estimate_tokens_from_bytes;

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("valid regex"))
}

// ── Cause taxonomy ──────────────────────────────────────────────────────────────
/// The break-cause taxonomy. An ENUM rather than `&str` for the same reason `cache_break::Cause`
/// is one: the TS types the remediation table as `Record<CacheBreakTimelineCause, string>`, so the
/// compiler — not a reviewer — is what guarantees every cause carries remediation text that ships
/// to the user verbatim.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum TimelineCause {
    ToolsetChanged,
    ToolsReordered,
    ToolSearchDeferred,
    McpToolsChanged,
    PluginsReloaded,
    ModelSwitch,
    EffortSwitch,
    HookInjection,
    SkillInjection,
    SkillDescriptionTruncation,
    SkillChanged,
    InlineExecResultChanged,
    ClaudeMdChanged,
    MemoryFileChanged,
    AgentMetadataChanged,
    SystemTimestamp,
    ContextOrderChanged,
    TtlExpiry,
    ColdStart,
    Compaction,
    SubagentInterleave,
    NormalGrowth,
    MessageTrimmed,
    MessageSpliced,
    AttachmentChanged,
    WorkingDirChanged,
    GitStateChanged,
    ThinkingConfigChanged,
    EffortParamChanged,
    ToolChoiceChanged,
    LookbackOverflow,
    BelowMinCacheable,
    CachingDisabled,
    Unclassified,
}

impl TimelineCause {
    /// Declaration order of the TS `CACHE_BREAK_REMEDIATION` literal — which IS the key order of
    /// the table when it is serialized, so this array is the wire contract, not a convenience.
    pub const ALL: [TimelineCause; 34] = [
        TimelineCause::ToolsetChanged,
        TimelineCause::ToolsReordered,
        TimelineCause::ToolSearchDeferred,
        TimelineCause::McpToolsChanged,
        TimelineCause::PluginsReloaded,
        TimelineCause::ModelSwitch,
        TimelineCause::EffortSwitch,
        TimelineCause::HookInjection,
        TimelineCause::SkillInjection,
        TimelineCause::SkillDescriptionTruncation,
        TimelineCause::SkillChanged,
        TimelineCause::InlineExecResultChanged,
        TimelineCause::ClaudeMdChanged,
        TimelineCause::MemoryFileChanged,
        TimelineCause::AgentMetadataChanged,
        TimelineCause::SystemTimestamp,
        TimelineCause::ContextOrderChanged,
        TimelineCause::TtlExpiry,
        TimelineCause::ColdStart,
        TimelineCause::Compaction,
        TimelineCause::SubagentInterleave,
        TimelineCause::NormalGrowth,
        TimelineCause::MessageTrimmed,
        TimelineCause::MessageSpliced,
        TimelineCause::AttachmentChanged,
        TimelineCause::WorkingDirChanged,
        TimelineCause::GitStateChanged,
        TimelineCause::ThinkingConfigChanged,
        TimelineCause::EffortParamChanged,
        TimelineCause::ToolChoiceChanged,
        TimelineCause::LookbackOverflow,
        TimelineCause::BelowMinCacheable,
        TimelineCause::CachingDisabled,
        TimelineCause::Unclassified,
    ];

    /// `EXPECTED_CAUSES` — causes that are expected cache BEHAVIOUR, not a misconfiguration: a cold
    /// warm, a compaction rebuild, the first write of appended content, and the interleave ARTIFACT
    /// (each stream keeps its own cache, so nothing actually broke). The ranking uses this to crown
    /// the top AVOIDABLE perpetrator instead of the noise floor. Set insertion order.
    pub const EXPECTED: [TimelineCause; 4] = [
        TimelineCause::ColdStart,
        TimelineCause::Compaction,
        TimelineCause::NormalGrowth,
        TimelineCause::SubagentInterleave,
    ];

    pub fn is_expected(self) -> bool {
        matches!(
            self,
            TimelineCause::ColdStart
                | TimelineCause::Compaction
                | TimelineCause::NormalGrowth
                | TimelineCause::SubagentInterleave
        )
    }

    /// The wire string — what serializes into `cause`.
    pub fn id(self) -> &'static str {
        match self {
            TimelineCause::ToolsetChanged => "TOOLSET_CHANGED",
            TimelineCause::ToolsReordered => "TOOLS_REORDERED",
            TimelineCause::ToolSearchDeferred => "TOOL_SEARCH_DEFERRED",
            TimelineCause::McpToolsChanged => "MCP_TOOLS_CHANGED",
            TimelineCause::PluginsReloaded => "PLUGINS_RELOADED",
            TimelineCause::ModelSwitch => "MODEL_SWITCH",
            TimelineCause::EffortSwitch => "EFFORT_SWITCH",
            TimelineCause::HookInjection => "HOOK_INJECTION",
            TimelineCause::SkillInjection => "SKILL_INJECTION",
            TimelineCause::SkillDescriptionTruncation => "SKILL_DESCRIPTION_TRUNCATION",
            TimelineCause::SkillChanged => "SKILL_CHANGED",
            TimelineCause::InlineExecResultChanged => "INLINE_EXEC_RESULT_CHANGED",
            TimelineCause::ClaudeMdChanged => "CLAUDE_MD_CHANGED",
            TimelineCause::MemoryFileChanged => "MEMORY_FILE_CHANGED",
            TimelineCause::AgentMetadataChanged => "AGENT_METADATA_CHANGED",
            TimelineCause::SystemTimestamp => "SYSTEM_TIMESTAMP",
            TimelineCause::ContextOrderChanged => "CONTEXT_ORDER_CHANGED",
            TimelineCause::TtlExpiry => "TTL_EXPIRY",
            TimelineCause::ColdStart => "COLD_START",
            TimelineCause::Compaction => "COMPACTION",
            TimelineCause::SubagentInterleave => "SUBAGENT_INTERLEAVE",
            TimelineCause::NormalGrowth => "NORMAL_GROWTH",
            TimelineCause::MessageTrimmed => "MESSAGE_TRIMMED",
            TimelineCause::MessageSpliced => "MESSAGE_SPLICED",
            TimelineCause::AttachmentChanged => "ATTACHMENT_CHANGED",
            TimelineCause::WorkingDirChanged => "WORKING_DIR_CHANGED",
            TimelineCause::GitStateChanged => "GIT_STATE_CHANGED",
            TimelineCause::ThinkingConfigChanged => "THINKING_CONFIG_CHANGED",
            TimelineCause::EffortParamChanged => "EFFORT_PARAM_CHANGED",
            TimelineCause::ToolChoiceChanged => "TOOL_CHOICE_CHANGED",
            TimelineCause::LookbackOverflow => "LOOKBACK_OVERFLOW",
            TimelineCause::BelowMinCacheable => "BELOW_MIN_CACHEABLE",
            TimelineCause::CachingDisabled => "CACHING_DISABLED",
            TimelineCause::Unclassified => "UNCLASSIFIED",
        }
    }

    /// `CACHE_BREAK_REMEDIATION` — byte-identical to the TS table; it ships to the user verbatim.
    /// Every entry states the CONDITION it fires under: commit c6802f0 shipped reload/MCP text
    /// asserting an UNCONDITIONAL cache reset that the docs contradict, and an absolute remediation
    /// is exactly how that error gets re-shipped.
    pub fn remediation(self) -> &'static str {
        match self {
            TimelineCause::ToolsetChanged => "A tool was added/removed/redefined mid-session. Keep the tool catalog byte-identical: use defer-loading stubs + tool-search rather than mutating the live tool set.",
            TimelineCause::ToolsReordered => "The tool set is the same but its ORDER shuffled. Emit tools in a stable sorted order so the catalog bytes never move.",
            TimelineCause::ToolSearchDeferred => "A deferred tool keeps loading mid-session (tool-search). Pre-load the tools you know you need at session start, or accept the one-time load cost.",
            TimelineCause::McpToolsChanged => "An MCP server / plugin toggled its non-deferred tools mid-session. Keep MCP servers connected for the whole session, or make their tools deferred.",
            TimelineCause::PluginsReloaded => "A /reload-plugins re-registered the tool + skill + agent catalogs together, rewriting the whole prefix at the write rate. Reload plugins at session start or in a fresh session, never mid-conversation.",
            TimelineCause::ModelSwitch => "The model changed mid-session — caches are model-specific. Hand off to a sub-agent instead of switching model in place.",
            TimelineCause::EffortSwitch => "The extended-thinking / reasoning-effort setting changed. Fix the effort level once at session start; changing it invalidates system + messages.",
            TimelineCause::HookInjection => "A per-turn hook writes a mutating block INTO the cached prefix. Move the hook output after the last cache breakpoint (into the current user message), or make it stable.",
            TimelineCause::SkillInjection => "A skill block was injected into the cached prefix. Load skills before the cache breakpoint stabilizes, or keep the skill set fixed.",
            TimelineCause::SkillDescriptionTruncation => "A skill description was truncated turn-to-turn, changing the catalog bytes. Keep skill descriptions stable-length within a session.",
            TimelineCause::SkillChanged => "A skill catalog / skill block changed content mid-session. Keep the available-skills set and their text fixed within a session.",
            TimelineCause::InlineExecResultChanged => "A skill `!`-operator shell result differs each turn (e.g. a clock/`date`/`git status`), so its injected block re-writes the prefix. Pin or remove the volatile inline command.",
            TimelineCause::ClaudeMdChanged => "An injected instruction file (CLAUDE.md / a rule) changed mid-session. Do not edit instruction files during a live session; a date inside them is SYSTEM_TIMESTAMP, not this.",
            TimelineCause::MemoryFileChanged => "An injected memory file (MEMORY.md / a wiki page) was rewritten while sessions were live, mutating msg[0] and re-writing the whole prefix — in EVERY session that injects it, not just the one that wrote it. Batch memory maintenance into one pass, run it when sessions are idle, or keep the injected index stable and put churn in pages that are not injected.",
            TimelineCause::AgentMetadataChanged => "Harness/agent metadata (the billing header cc_version, the agent-types list) changed — usually a Claude Code upgrade. Unavoidable once; avoid resuming huge sessions right after upgrading.",
            TimelineCause::SystemTimestamp => "A moving date/clock inside an otherwise-static block breaks the cache every day/turn. Move the timestamp out of the cached prefix into the current user message.",
            TimelineCause::ContextOrderChanged => "The same blocks are injected in a DIFFERENT order — the cache is byte-order sensitive, so this still breaks it. Fix the injection order to be deterministic.",
            TimelineCause::TtlExpiry => "No prefix change — the cache entry simply expired between turns. A heartbeat within the TTL (5m/1h) would convert these writes back to cache_read.",
            TimelineCause::ColdStart => "A cold cache warm (first turn / resume / no prior cached prefix). Expected once per session; not an avoidable per-turn break.",
            TimelineCause::Compaction => "Conversation compaction rebuilt the message layer. Expected once per compaction; avoid compacting more than necessary.",
            TimelineCause::SubagentInterleave => "Two requests grouped under one session id belong to DIFFERENT streams — sub-agent calls carry the parent's session id. Claimed on either of two signatures: the A→B→A pattern (this request matches turn-2's tool catalog + model, not turn-1's), or a different msg[0] prompt (the conversation's own opening words, immutable within one conversation). Each stream keeps its OWN cache, so nothing actually broke and there is nothing to fix; the child bills its own (smaller) prefix. Pin the sub-agent's tools + model in its frontmatter to shrink that footprint.",
            TimelineCause::NormalGrowth => "Not a break — append-only growth: this turn's NEW content was cached for the first time (expected incremental write). Reduce it only by producing/ingesting less content per turn.",
            TimelineCause::MessageTrimmed => "A block was REMOVED from the cached message prefix (harness context-editing / tool-result clearing / message deletion) — everything after the removal point re-writes. Prefer compaction or a fresh session over mid-session trimming of a huge transcript.",
            TimelineCause::MessageSpliced => "A NEW block was INSERTED into the middle of the cached prefix, shifting every later block — everything after the splice point re-writes. The actor is whatever injected the block (typically the harness re-homing a hook/system message), never the shifted bystanders after it.",
            TimelineCause::AttachmentChanged => "A non-text block (image / tool_use input) inside the cached prefix changed or moved. Past attachments should be immutable; an image riding in the prefix re-bills the tail on any change.",
            TimelineCause::WorkingDirChanged => "The environment block (working directory / platform / shell / OS) differs between these two turns, and it sits inside the cached system prefix — so a cache entry is scoped to ONE directory, and a second worktree of the same repository is a different prefix. This fires only ACROSS directories, never within one: `/cd` is engineered cache-safe (the new directory's CLAUDE.md is appended as a message instead of rebuilding the system prompt). Keep long-running work in one directory, or accept one cold warm per directory.",
            TimelineCause::GitStateChanged => "The startup git snapshot (branch, status, recent commits) carried in the system prefix differs. It is captured ONCE at session start and never updates during a session, so this can only fire between turns that started from different snapshots — a resume, or a second stream sharing this session id. Sequential sessions share a prefix only when that snapshot matches, so branch/commit churn between sessions costs one cold warm each; nothing to fix mid-session.",
            TimelineCause::ThinkingConfigChanged => "The thinking configuration changed (type or budget_tokens). It is rendered into the prompt itself, so message-level breakpoints ALWAYS miss; tools and system miss only on models that render the configuration ahead of them, and the docs do not enumerate which. Fix the thinking config once at session start.",
            TimelineCause::EffortParamChanged => "output_config.effort changed between two EXPLICIT values. Message blocks always miss; the effect on tools/system is model-specific. Setting effort explicitly to the model default is a documented no-op, so this never fires on an absent↔present transition — only on two different explicit values. Pick one effort level per conversation.",
            TimelineCause::ToolChoiceChanged => "tool_choice changed between two explicit values. Per the docs this invalidates MESSAGE blocks only — tools and system stay cached — so the write is bounded by the message layer rather than the whole prefix. Keep tool_choice constant for the lifetime of a cached conversation.",
            TimelineCause::LookbackOverflow => "No block changed, yet the cache found nothing to read: at least 20 blocks were appended since the last cache WRITE, and the lookback window is 20 blocks, so it walked past the last entry. This is claimed only when cache_read is 0 with an unchanged prefix — ordinary growth still reads. Add a second breakpoint closer to the growing tail so a write accumulates there before the window overruns.",
            TimelineCause::BelowMinCacheable => "Both usage counters are 0 while the request DID carry cache_control markers, and the prompt is under this model's minimum cacheable length — a below-minimum prompt is silently not cached, with no error. The minimum is per model (512 to 4,096 tokens, an 8x spread), so this fires only when the estimate is under THIS model's threshold. Expand the cached content to reach it, or accept the full input rate on these calls.",
            TimelineCause::CachingDisabled => "The request carried NO cache_control marker anywhere, so nothing was offered to the cache and both counters are 0 by construction. That happens when DISABLE_PROMPT_CACHING (or its per-model variant) is set, and also when the caller deliberately does not cache a class of calls — Claude Code's small Haiku utility calls historically did not (measured on CC ≤2.1.220; since 2.1.221 its auto-mode permission checks reuse the cached conversation prefix, so that class is shrinking). Unset the environment variable only if this was not intended.",
            TimelineCause::Unclassified => "A break whose cause could not be localised from the prefix diff. Inspect the attached raw diff summary and the raw bodies around this turn.",
        }
    }

    /// The whole table as the TS serializes it — key ORDER included (`ALL` is the literal order).
    pub fn remediation_table() -> Value {
        let mut m = serde_json::Map::new();
        for c in TimelineCause::ALL {
            m.insert(c.id().to_owned(), Value::String(c.remediation().to_owned()));
        }
        Value::Object(m)
    }
}

/// TTL tier a timing-driven break landed in (mirrors the gap-report buckets). Slice 2 sets it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TtlTier {
    FiveMin,
    OneHour,
    None,
}

impl TtlTier {
    pub fn id(self) -> &'static str {
        match self {
            TtlTier::FiveMin => "5m",
            TtlTier::OneHour => "1h",
            TtlTier::None => "none",
        }
    }
}

// ── Minimum cacheable prompt length, per model ───────────────────────────────────
// A prompt below its model's minimum is NOT cached and NO error is raised: both usage counters come
// back 0 and the call silently pays the full input rate. The spread is 8x (512 -> 4,096), so a
// threshold keyed on one model id is wrong for every other model — hence a table, and hence an
// UNKNOWN model yields NO verdict rather than a borrowed number.
// Source: reports/cache-invalidation-research/20260804_142700+0200-prompt-caching-docs.md §2.5,
// whose §4.1 records that two fetches of the SAME page returned two different lists. Re-verify a
// row against the live page before trusting it for a model not measured on this machine.
const MIN_CACHEABLE_TOKENS: [(&str, u32); 4] = [
    (r"opus-5|fable-5|mythos-5", 512),
    (
        r"opus-4[-.]8|sonnet-5|sonnet-4[-.]6|sonnet-4[-.]5|opus-4[-.]1|opus-4($|[^-.0-9])|sonnet-4($|[^-.0-9])",
        1024,
    ),
    (r"opus-4[-.]7|mythos-preview|3[-.]5-haiku|haiku-3[-.]5", 2048),
    (r"opus-4[-.]6|opus-4[-.]5|haiku-4[-.]5", 4096),
];

fn min_cacheable_rows() -> &'static [(regex::Regex, u32)] {
    static ROWS: OnceLock<Vec<(regex::Regex, u32)>> = OnceLock::new();
    ROWS.get_or_init(|| {
        MIN_CACHEABLE_TOKENS
            .iter()
            .map(|(p, min)| (regex::Regex::new(p).expect("valid regex"), *min))
            .collect()
    })
}

/// The model's documented minimum cacheable prompt length, or `None` when we have no row for it.
/// `None` means "no claim" — never a default: a borrowed threshold would make BELOW_MIN_CACHEABLE
/// fire on models whose real minimum is up to 8x away.
pub fn min_cacheable_tokens_for(model: &str) -> Option<u32> {
    let m = model.to_lowercase();
    min_cacheable_rows().iter().find(|(r, _)| r.is_match(&m)).map(|(_, v)| *v)
}

// ── Environment / git-snapshot regions of the system prompt ──────────────────────
// Both live INSIDE one big system block (measured across the live spool, 2026-08-04: sys[2] for
// SDK/sub-agent requests, sys[3] for the CLI), so the positional block diff could only ever say
// "that block changed" and would file two documented causes under UNCLASSIFIED. Extracting the two
// regions by hand is what lets the classifier name them. POINTER-ONLY: only a hash of the region is
// kept — the cwd is an absolute home path and must never reach a report.
static ENV_SDK: OnceLock<regex::Regex> = OnceLock::new();

/// The CLI spelling has no closing delimiter; it runs to the next markdown heading. The JS uses a
/// `(?=\n# |$)` lookahead, which `regex` cannot express — but a lazy match with a lookahead ends at
/// the FIRST `\n# ` at or after the anchor, which is a plain `find`.
const ENV_CLI_ANCHOR: &str = "# Environment\nYou have been invoked in the following environment:";

fn extract_env_region(system_text: &str) -> &str {
    if let Some(m) = re(&ENV_SDK, r"(?s)<env>.*?</env>").find(system_text) {
        return m.as_str();
    }
    let Some(start) = system_text.find(ENV_CLI_ANCHOR) else { return "" };
    let after = start + ENV_CLI_ANCHOR.len();
    match system_text[after..].find("\n# ") {
        Some(rel) => &system_text[start..after + rel],
        None => &system_text[start..],
    }
}

/// The git snapshot: from `gitStatus:` through the end of the `Recent commits:` list. It STOPS at
/// the blank line that ends that list, because harness prose follows it in the CLI spelling and
/// blaming a harness-upgrade wording change on "git state changed" would be a confident lie.
fn extract_git_region(system_text: &str) -> &str {
    let Some(start) = system_text.find("gitStatus:") else { return "" };
    // No commit list (a repo with no commits, or a truncated block): keep the region to the end
    // rather than guess a boundary.
    let Some(rel) = system_text[start..].find("Recent commits:") else { return &system_text[start..] };
    let commits = start + rel;
    match system_text[commits..].find("\n\n") {
        Some(r2) => &system_text[start..commits + r2],
        None => &system_text[start..],
    }
}

// ── Stable fingerprint + volatile normalization ──────────────────────────────────
/// FNV-1a 32-bit — a cheap, dependency-free stable hash. We store this hash of a block's
/// cache-relevant bytes, NEVER the bytes, so the prefix stays pointer-only. Two turns' blocks are
/// "the same" iff their fingerprints match, which is the cache's own byte-identity test at hash
/// granularity.
///
/// The JS is 32-bit-modular: each `h << n` is a SIGNED int32, the five terms sum in float64 (below
/// 2^34, so exact), and `>>> 0` takes the result mod 2^32. Unsigned wrapping arithmetic agrees mod
/// 2^32. `charCodeAt` means UTF-16 CODE UNITS, so an astral character contributes TWO iterations —
/// `encode_utf16()` is the only faithful walk. Zero-padded to 8 hex digits (`padStart`).
fn fnv1a(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for u in s.encode_utf16() {
        h ^= u as u32;
        let sum = h
            .wrapping_shl(1)
            .wrapping_add(h.wrapping_shl(4))
            .wrapping_add(h.wrapping_shl(7))
            .wrapping_add(h.wrapping_shl(8))
            .wrapping_add(h.wrapping_shl(24));
        h = h.wrapping_add(sum);
    }
    format!("{h:08x}")
}

static NV_ISO: OnceLock<regex::Regex> = OnceLock::new();
static NV_DATE: OnceLock<regex::Regex> = OnceLock::new();
static NV_TIME: OnceLock<regex::Regex> = OnceLock::new();
static NV_TODAY: OnceLock<regex::Regex> = OnceLock::new();
static NV_AGO: OnceLock<regex::Regex> = OnceLock::new();

/// Strip the volatile bits (ISO dates, clock times, "Today's date is X", relative-time phrases) so
/// two blocks that differ ONLY by a moving timestamp normalize to the same string — that is how a
/// SYSTEM_TIMESTAMP break is told apart from a real content change (CLAUDE_MD_CHANGED etc.).
/// Order is load-bearing: the ISO pass must run before the bare-date pass, or the date half of an
/// ISO stamp is eaten first and the remainder never matches.
fn normalize_volatile(text: &str) -> String {
    let a = re(&NV_ISO, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?").replace_all(text, "<TS>");
    let b = re(&NV_DATE, r"\d{4}-\d{2}-\d{2}").replace_all(&a, "<DATE>");
    let c = re(&NV_TIME, r"(?-u:\b)\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?(?-u:\b)").replace_all(&b, "<TIME>");
    let d = re(&NV_TODAY, r"(?i)Today'?s date is[^\n.]*").replace_all(&c, "Today's date is <DATE>");
    re(&NV_AGO, r"(?i)(?-u:\b)\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago(?-u:\b)")
        .replace_all(&d, "<AGO>")
        .into_owned()
}

// ── Content classification of an injected text block ──────────────────────────────
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BlockContentKind {
    ClaudeMd,
    Rule,
    Memory,
    AgentMeta,
    SkillCatalog,
    AgentCatalog,
    Hook,
    Date,
    ExecResult,
    PostCompact,
    System,
    UserText,
    History,
    Attachment,
}

impl BlockContentKind {
    pub fn id(self) -> &'static str {
        match self {
            BlockContentKind::ClaudeMd => "claudemd",
            BlockContentKind::Rule => "rule",
            BlockContentKind::Memory => "memory",
            BlockContentKind::AgentMeta => "agentmeta",
            BlockContentKind::SkillCatalog => "skillcatalog",
            BlockContentKind::AgentCatalog => "agentcatalog",
            BlockContentKind::Hook => "hook",
            BlockContentKind::Date => "date",
            BlockContentKind::ExecResult => "execresult",
            BlockContentKind::PostCompact => "postcompact",
            BlockContentKind::System => "system",
            BlockContentKind::UserText => "usertext",
            BlockContentKind::History => "history",
            BlockContentKind::Attachment => "attachment",
        }
    }
}

static CK_AGENTMETA: OnceLock<regex::Regex> = OnceLock::new();
static CK_POSTCOMPACT: OnceLock<regex::Regex> = OnceLock::new();
static CK_CLAUDEMD: OnceLock<regex::Regex> = OnceLock::new();
static CK_RULE: OnceLock<regex::Regex> = OnceLock::new();
static CK_MEMORY: OnceLock<regex::Regex> = OnceLock::new();
static CK_EXEC: OnceLock<regex::Regex> = OnceLock::new();
static CK_SKILLCAT: OnceLock<regex::Regex> = OnceLock::new();
static CK_AGENTCAT: OnceLock<regex::Regex> = OnceLock::new();
static CK_HOOK: OnceLock<regex::Regex> = OnceLock::new();
static CK_SYSREMINDER: OnceLock<regex::Regex> = OnceLock::new();
static CK_HOOKWORD: OnceLock<regex::Regex> = OnceLock::new();
static CK_DATE: OnceLock<regex::Regex> = OnceLock::new();

/// A pure text→kind function, and the kinds it MISSES are exactly how a real perpetrator ends up
/// filed as UNCLASSIFIED. BRANCH ORDER IS THE CLASSIFIER — three orderings are deliberate and are
/// pinned by the fixture:
///   * `agentmeta` first, so a billing header inside a `<system-reminder>` is not "just a reminder";
///   * `postcompact` before `claudemd`, so a compaction summary QUOTING an injected CLAUDE.md
///     header stays a compaction;
///   * `memory` before `hook`, because a memory PAGE body can quote a hook marker like
///     `[janitor-memory]` and a real file injection must outrank a coincidental mention inside it.
///     The auto-memory file is injected into msg[0] exactly like CLAUDE.md, but its path is neither
///     `CLAUDE.md` nor under `.claude/rules/`, so before this branch existed it fell through to
///     `usertext` → UNCLASSIFIED — 19% of all classified break tokens on this machine, with the
///     actor recorded only as "usertext block changed at pos 38".
///
/// ⚠ `System` IS UNREACHABLE, and that is the TS behaviour, not a porting bug. The guard above it
/// is `<system-reminder>` AND `/hook|inbox|heartbeat|reminder/i` — and the tag `<system-reminder>`
/// itself CONTAINS "reminder", so every system-reminder block classifies as `Hook` and the
/// `System` arm can never be reached (nor can `label_for`'s `System` case). Reproduced verbatim
/// rather than "fixed": collapsing it would silently re-file every reminder block under a different
/// cause and move real break tokens between buckets.
pub fn classify_content_kind(text: &str) -> BlockContentKind {
    if re(&CK_AGENTMETA, r"x-anthropic-billing-header|cc_version=|cc_entrypoint=").is_match(text) {
        return BlockContentKind::AgentMeta;
    }
    if re(&CK_POSTCOMPACT, r"(?i)This session is being continued from a previous|conversation summary so far|compacted the (?:previous )?conversation|<compaction_summary|Analysis:[\s\S]{0,80}Summary:").is_match(text) {
        return BlockContentKind::PostCompact;
    }
    if re(&CK_CLAUDEMD, r"(?m)Contents of [^\n\r\u{2028}\u{2029}]{0,300}CLAUDE\.md|^#\s*CLAUDE\.md").is_match(text) {
        return BlockContentKind::ClaudeMd;
    }
    if re(&CK_RULE, r"Contents of [^\n\r\u{2028}\u{2029}]{0,300}[/\\]\.claude[/\\]rules[/\\]").is_match(text) {
        return BlockContentKind::Rule;
    }
    if re(&CK_MEMORY, r"Contents of [^\n\r\u{2028}\u{2029}]{0,300}[/\\]memory[/\\]|auto-memory, persists across conversations").is_match(text) {
        return BlockContentKind::Memory;
    }
    if re(&CK_EXEC, r"<local-command-stdout>|<command-output>|command-stdout|<function_results>").is_match(text) {
        return BlockContentKind::ExecResult;
    }
    if re(&CK_SKILLCAT, r"skills are available for use with the Skill tool|The following skills are available|Available skills:").is_match(text) {
        return BlockContentKind::SkillCatalog;
    }
    if re(&CK_AGENTCAT, r"Available agent types|available agent types for the Agent tool|subagent_type").is_match(text) {
        return BlockContentKind::AgentCatalog;
    }
    // Per-turn injections that land INSIDE user messages (not <system-reminder>-wrapped). Match the
    // header SHAPE (`<hookname> hook additional context`), never the message content: a matcher
    // keyed on "Token spike" goes blind the moment the hook's wording changes, which is how this
    // class of gap gets reintroduced. `PreToolUse:` was missing from this alternation and cost
    // $2.84 in one turn (2026-08-13T01:08:10Z, 453,881 tokens landed in UNCLASSIFIED, unnamed).
    if re(&CK_HOOK, r"(?i)<pss-skills>|\[janitor-memory\]|UserPromptSubmit hook additional context|(?:Pre|Post)ToolUse:\S* hook additional context|task tools haven't been used recently").is_match(text) {
        return BlockContentKind::Hook;
    }
    if re(&CK_SYSREMINDER, r"<system-reminder>").is_match(text)
        && re(&CK_HOOKWORD, r"(?i)hook|inbox|heartbeat|reminder").is_match(text)
    {
        return BlockContentKind::Hook;
    }
    if re(&CK_DATE, r"Today'?s date is|# *currentDate|Current date:").is_match(text) {
        return BlockContentKind::Date;
    }
    if re(&CK_SYSREMINDER, r"<system-reminder>").is_match(text) {
        return BlockContentKind::System;
    }
    BlockContentKind::UserText
}

/// The cause a changed block of this KIND implies. Slice 2's block diff calls it.
pub fn cause_for_content_kind(kind: BlockContentKind) -> TimelineCause {
    match kind {
        BlockContentKind::ClaudeMd | BlockContentKind::Rule => TimelineCause::ClaudeMdChanged,
        BlockContentKind::Memory => TimelineCause::MemoryFileChanged,
        BlockContentKind::AgentMeta | BlockContentKind::AgentCatalog => TimelineCause::AgentMetadataChanged,
        BlockContentKind::SkillCatalog => TimelineCause::SkillChanged,
        BlockContentKind::Hook => TimelineCause::HookInjection,
        BlockContentKind::Date => TimelineCause::SystemTimestamp,
        BlockContentKind::ExecResult => TimelineCause::InlineExecResultChanged,
        BlockContentKind::PostCompact => TimelineCause::Compaction,
        BlockContentKind::Attachment => TimelineCause::AttachmentChanged,
        _ => TimelineCause::Unclassified,
    }
}

// ── Segmentation ─────────────────────────────────────────────────────────────────
/// One classified slice of an injected block. Borrows the block text — a multi-MB system prompt is
/// segmented on every scanned body, and copying each segment would double the peak for nothing.
pub struct Segment<'a> {
    pub kind: BlockContentKind,
    pub label: String,
    pub text: &'a str,
}

static SEG_BOUNDARY: OnceLock<regex::Regex> = OnceLock::new();

/// Split one injected text block into classified SEGMENTS at "Contents of <path>" boundaries —
/// Claude Code concatenates CLAUDE.md + every rule + memory + the skills list into ONE giant
/// system-reminder, so segmenting is what lets the diff pinpoint the CLAUDE.md segment vs a rule vs
/// the skills list vs a date, instead of blaming the whole mega-block. Fail-soft: a block with no
/// boundary markers is one segment.
///
/// The SEGMENTATION decides which culprit a break can be pinned to, so a segment nothing classifies
/// is how a real perpetrator ends up as UNCLASSIFIED (TRDD-00NOBU9W).
pub fn segment_injected<'a>(text: &'a str, block_label: &str) -> Vec<Segment<'a>> {
    let marks: Vec<(usize, &str)> = re(&SEG_BOUNDARY, r"Contents of ([^\n(]+?\.[A-Za-z0-9_]+)")
        .captures_iter(text)
        .map(|c| {
            let whole = c.get(0).expect("group 0 always matches");
            let path = c.get(1).expect("group 1 is not optional");
            (whole.start(), path.as_str().trim())
        })
        .collect();

    if marks.is_empty() {
        let kind = classify_content_kind(text);
        return vec![Segment { kind, label: label_for(kind, text, block_label), text }];
    }

    let mut segs = Vec::with_capacity(marks.len() + 1);
    // The leading region before the first "Contents of" (harness prose / billing header / date).
    if marks[0].0 > 0 {
        let lead = &text[..marks[0].0];
        let kind = classify_content_kind(lead);
        segs.push(Segment { kind, label: label_for(kind, lead, block_label), text: lead });
    }
    for (i, (start, path)) in marks.iter().enumerate() {
        let end = marks.get(i + 1).map_or(text.len(), |m| m.0);
        let body = &text[*start..end];
        let kind = classify_content_kind(body);
        segs.push(Segment { kind, label: (*path).to_owned(), text: body });
    }
    segs
}

fn label_for_kind(kind: BlockContentKind, fallback: &str) -> String {
    match kind {
        BlockContentKind::AgentMeta => "harness/billing header".to_owned(),
        BlockContentKind::SkillCatalog => "available-skills catalog".to_owned(),
        BlockContentKind::AgentCatalog => "agent-types catalog".to_owned(),
        BlockContentKind::Hook => "hook injection".to_owned(),
        BlockContentKind::Date => "system date/clock".to_owned(),
        BlockContentKind::ExecResult => "inline command result".to_owned(),
        _ => fallback.to_owned(),
    }
}

static HS_PSS: OnceLock<regex::Regex> = OnceLock::new();
static HS_JMEM: OnceLock<regex::Regex> = OnceLock::new();
static HS_JHB: OnceLock<regex::Regex> = OnceLock::new();
static HS_TASKLIST: OnceLock<regex::Regex> = OnceLock::new();
static HS_UPS: OnceLock<regex::Regex> = OnceLock::new();
static HS_PTU: OnceLock<regex::Regex> = OnceLock::new();
static HS_TOKENGUARD: OnceLock<regex::Regex> = OnceLock::new();
static HS_CTXWATCH: OnceLock<regex::Regex> = OnceLock::new();
static HS_SANITIZER: OnceLock<regex::Regex> = OnceLock::new();
static HS_INBOX: OnceLock<regex::Regex> = OnceLock::new();
static HS_SPYGLASS: OnceLock<regex::Regex> = OnceLock::new();
static HS_WORKTREE: OnceLock<regex::Regex> = OnceLock::new();

/// BACKTRACE TO THE PERPETRATOR (the user's core ask): a HOOK_INJECTION break must name WHICH
/// injector wrote the mutating block, because the culprit is the hook/skill/harness process, not
/// the transcript it perturbed. Identified from a stable content signature; only the short NAME is
/// kept (pointer-only — never the block text). It flows into the block label → the culpritId → the
/// repeat-offender rollup, so two breaks from the SAME injector collapse into ONE chronic
/// perpetrator ("pss-skills broke the cache on 40 turns"). Order matters: the first match wins.
fn hook_signature(text: &str) -> Option<&'static str> {
    if re(&HS_PSS, r"<pss-skills>").is_match(text) {
        return Some("pss-skills (perfect-skill-suggester)");
    }
    if re(&HS_JMEM, r"\[janitor-memory\]").is_match(text) {
        return Some("janitor-memory recall");
    }
    if re(&HS_JHB, r"\[janitor-heartbeat\]").is_match(text) {
        return Some("janitor-heartbeat");
    }
    if re(&HS_TASKLIST, r"(?i)task tools haven't been used recently").is_match(text) {
        return Some("harness task-list reminder");
    }
    if re(&HS_UPS, r"UserPromptSubmit hook additional context").is_match(text) {
        return Some("UserPromptSubmit injection");
    }
    if re(&HS_PTU, r"PostToolUse:\S* hook additional context").is_match(text) {
        return Some("PostToolUse injection");
    }
    if re(&HS_TOKENGUARD, r"(?i)token-guard|hard budget|token budget still exceeded").is_match(text) {
        return Some("token-guard");
    }
    if re(&HS_CTXWATCH, r"(?i)Context window:\s*\d|pre-tool-context-usage|context watchdog").is_match(text) {
        return Some("context-usage watchdog");
    }
    if re(&HS_SANITIZER, r"(?i)post-mcp-sanitizer|prompt-injection shape").is_match(text) {
        return Some("mcp-sanitizer");
    }
    if re(&HS_INBOX, r"(?i)AI Maestro|inbox notification|unread messages").is_match(text) {
        return Some("ai-maestro inbox");
    }
    if re(&HS_SPYGLASS, r"(?i)spyglass").is_match(text) {
        return Some("spyglass");
    }
    if re(&HS_WORKTREE, r"(?i)worktree|task-notification").is_match(text) {
        return Some("worktree/task notifier");
    }
    None
}

/// Resolve the label for an injected segment, preferring the specific injector name for
/// hook/system blocks so the backtrace points at the perpetrator, falling back to the generic
/// per-kind label. (The `System` arm is unreachable — see `classify_content_kind`.)
fn label_for(kind: BlockContentKind, text: &str, fallback: &str) -> String {
    if matches!(kind, BlockContentKind::Hook | BlockContentKind::System) {
        if let Some(sig) = hook_signature(text) {
            return format!("hook: {sig}");
        }
    }
    label_for_kind(kind, fallback)
}

// ── Tool-name helpers (slice 2's tools diff) ─────────────────────────────────────
/// The built-in tools the harness defer-loads and toggles via ToolSearch. When a break's changed
/// tool set is entirely within this set, the perpetrator is the harness ToolSearch mechanism
/// churning its deferred built-ins — NOT the user's own MCP/tool config — so it is attributed to
/// one stable actor instead of the volatile add/remove list.
pub const DEFERRED_BUILTINS: [&str; 26] = [
    "AskUserQuestion", "CronCreate", "CronDelete", "CronList", "SendMessage",
    "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
    "WebFetch", "WebSearch", "NotebookEdit", "LSP", "Monitor", "PushNotification",
    "RemoteTrigger", "DesignSync", "EnterPlanMode", "ExitPlanMode", "EnterWorktree",
    "ExitWorktree", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "ListMcpResourcesTool",
];

pub fn is_deferred_builtin(name: &str) -> bool {
    DEFERRED_BUILTINS.contains(&name)
}

static MCP_SERVER: OnceLock<regex::Regex> = OnceLock::new();

/// The distinct MCP server names behind tool names of the form `mcp__<server>__<tool>`, so an
/// MCP_TOOLS_CHANGED break backtraces to the SERVER that connected/disconnected rather than to the
/// individual tools it carried. Sorted, like the JS `[...set].sort()` (server names are ASCII, so
/// byte order and UTF-16 order agree).
pub fn mcp_servers_of<S: AsRef<str>>(names: &[S]) -> Vec<String> {
    let rx = re(&MCP_SERVER, r"^mcp__(.+?)__");
    let mut set: HashSet<String> = HashSet::new();
    for n in names {
        if let Some(c) = rx.captures(n.as_ref()) {
            set.insert(c[1].to_owned());
        }
    }
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

// ── Turn prefix (compact, pointer-only) ──────────────────────────────────────────
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layer {
    System,
    Message,
}

impl Layer {
    pub fn id(self) -> &'static str {
        match self {
            Layer::System => "system",
            Layer::Message => "message",
        }
    }
}

pub struct PrefixTool {
    pub name: String,
    pub deferred: bool,
    pub is_mcp: bool,
    pub fp: String,
}

impl PrefixTool {
    pub fn to_value(&self) -> Value {
        json!({ "name": self.name, "deferred": self.deferred, "isMcp": self.is_mcp, "fp": self.fp })
    }
}

pub struct PrefixBlock {
    pub layer: Layer,
    pub kind: BlockContentKind,
    pub label: String,
    /// Fingerprint of the raw bytes (byte identity, hashed).
    pub fp: String,
    /// Fingerprint of the timestamp-normalized bytes (for SYSTEM_TIMESTAMP detection).
    pub norm: String,
    /// UTF-16 length, as in the TS — `SKILL_DESCRIPTION_TRUNCATION` reads it as a shrink signal.
    pub len: usize,
    pub tokens_approx: u64,
}

impl PrefixBlock {
    pub fn to_value(&self) -> Value {
        json!({
            "layer": self.layer.id(),
            "kind": self.kind.id(),
            "label": self.label,
            "fp": self.fp,
            "norm": self.norm,
            "len": self.len,
            "tokensApprox": self.tokens_approx,
        })
    }
}

pub struct TurnPrefix {
    pub model: String,
    /// Request parameters rendered into the prompt. Kept SEPARATE (they were one blended `effort`
    /// signature until TRDD-B9ERTBZ9) because the docs give each a different blast radius and a
    /// different remedy, and a blended signature could only ever report the generic EFFORT_SWITCH.
    /// `""` means the parameter was ABSENT — which is NOT the same as any explicit value.
    pub thinking: String,
    pub effort_param: String,
    pub tool_choice: String,
    /// `body.speed` (fast mode) — the residual, with no specific cause of its own.
    pub speed: String,
    pub env_fp: String,
    pub env_norm: String,
    pub git_fp: String,
    pub git_norm: String,
    /// Whole-request signals for the no-cache-activity diagnosis.
    pub has_cache_control: bool,
    /// Estimated over EVERY message + system + tools, not just the prefix.
    pub prompt_tokens_approx: u64,
    /// `messages.length` — the conservative unit for the 20-block lookback.
    pub message_count: usize,
    pub tools: Vec<PrefixTool>,
    pub system_blocks: Vec<PrefixBlock>,
    /// Cached message-prefix injected blocks (up to the last message cache_control).
    pub message_blocks: Vec<PrefixBlock>,
}

impl TurnPrefix {
    /// Key ORDER mirrors the TS object literal — the parity oracle compares it directly.
    pub fn to_value(&self) -> Value {
        json!({
            "model": self.model,
            "thinking": self.thinking,
            "effortParam": self.effort_param,
            "toolChoice": self.tool_choice,
            "speed": self.speed,
            "envFp": self.env_fp,
            "envNorm": self.env_norm,
            "gitFp": self.git_fp,
            "gitNorm": self.git_norm,
            "hasCacheControl": self.has_cache_control,
            "promptTokensApprox": self.prompt_tokens_approx,
            "messageCount": self.message_count,
            "tools": self.tools.iter().map(PrefixTool::to_value).collect::<Vec<_>>(),
            "systemBlocks": self.system_blocks.iter().map(PrefixBlock::to_value).collect::<Vec<_>>(),
            "messageBlocks": self.message_blocks.iter().map(PrefixBlock::to_value).collect::<Vec<_>>(),
        })
    }
}

/// `typeof v === 'object'` in JS — which is TRUE for arrays, and the distinction is load-bearing in
/// three places here (`paramSignature`, the body guard, the per-block guard).
fn is_js_object(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// A stable signature for one request parameter. Returns `""` for ABSENT — the distinction is
/// load-bearing: the docs say "setting a parameter explicitly to its default value is equivalent to
/// omitting it", so absent↔present cannot be judged without a per-model defaults table that no
/// documentation page provides. Only two different EXPLICIT values are decidable.
fn param_signature(v: Option<&Value>) -> String {
    let Some(v) = v else { return String::new() };
    if v.is_null() {
        return String::new();
    }
    if is_js_object(v) {
        // thinking / tool_choice both key on `type` (+ budget / tool name) — spelled out explicitly
        // so key-order churn in the raw JSON can never read as a parameter change.
        if let Some(t) = v.get("type").and_then(Value::as_str) {
            let extra = if let Some(b) = v.get("budget_tokens").and_then(Value::as_f64) {
                format!(":{}", fmt_js_num(b))
            } else if let Some(n) = v.get("name").and_then(Value::as_str) {
                format!(":{n}")
            } else {
                String::new()
            };
            return format!("{t}{extra}");
        }
        return serde_json::to_string(v).unwrap_or_default();
    }
    js_string(v)
}

fn effort_param_of(body: &Value) -> String {
    match body.get("output_config") {
        Some(oc) if is_js_object(oc) => oc.get("effort").and_then(Value::as_str).unwrap_or("").to_owned(),
        _ => String::new(),
    }
}

fn to_prefix_block(layer: Layer, kind: BlockContentKind, label: String, text: &str) -> PrefixBlock {
    PrefixBlock {
        layer,
        kind,
        label,
        fp: fnv1a(text),
        norm: fnv1a(&normalize_volatile(text)),
        len: utf16_len(text),
        tokens_approx: estimate_tokens_from_bytes(text.len() as u64),
    }
}

/// Non-text blocks (images, tool_use inputs) were previously SKIPPED from the prefix, so a change
/// there was an invisible prefix mutation landing in UNCLASSIFIED. Fingerprinted by type+name+SIZE
/// only — pointer-only, never the input JSON or the base64 bytes — so the diff can name
/// ATTACHMENT_CHANGED. The two sizes are UTF-16 lengths, as in the TS.
fn attachment_prefix_block(b: &Value, msg_index: usize) -> Option<PrefixBlock> {
    let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
    if ty != "tool_use" && ty != "image" {
        return None;
    }
    let name = b.get("name").and_then(Value::as_str).unwrap_or("?");
    let img_len = b
        .get("source")
        .and_then(|s| s.get("data"))
        .and_then(Value::as_str)
        .map_or(0, utf16_len);
    let (sig, label) = if ty == "tool_use" {
        let input = b.get("input").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({}));
        let json_len = utf16_len(&serde_json::to_string(&input).unwrap_or_default());
        (format!("tool_use:{name}:{json_len}"), format!("msg[{msg_index}] tool_use {name}"))
    } else {
        (format!("image:{img_len}"), format!("msg[{msg_index}] image"))
    };
    Some(PrefixBlock {
        layer: Layer::Message,
        kind: BlockContentKind::Attachment,
        label,
        fp: fnv1a(&sig),
        norm: fnv1a(&sig),
        len: utf16_len(&sig),
        tokens_approx: 0,
    })
}

/// The BYTE length of what `message_block_text` would return, WITHOUT building the string — the
/// prompt total is needed for EVERY message of EVERY scanned body, and materializing a whole
/// conversation's tool_result text per body, for one integer, measurably slowed the bounded scan.
///
/// ⚠ NOT a byte-count of `message_block_text`'s output, and the gap is deliberate: this counts only
/// a STRING `.text`, while the text builder stringifies ANY truthy `.text`. A tool_result carrying
/// `{text: 5}` therefore contributes "5" to the fingerprinted block text and ZERO to the prompt
/// total. Ported as-is and pinned by the fixture — the two halves disagreeing is the TS behaviour,
/// and "fixing" either one silently moves every prompt-size estimate.
fn message_block_text_bytes(b: &Value) -> u64 {
    let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "text" {
        if let Some(t) = b.get("text").and_then(Value::as_str) {
            return t.len() as u64;
        }
    }
    if ty == "tool_result" {
        match b.get("content") {
            Some(Value::String(c)) => return c.len() as u64,
            Some(Value::Array(a)) => {
                let mut n: u64 = 0;
                for x in a {
                    let t = if is_js_object(x) { x.get("text").and_then(Value::as_str) } else { None };
                    // +1 for the '\n' the join adds.
                    n += t.map_or(0, |s| s.len() as u64) + 1;
                }
                return if n > 0 { n - 1 } else { 0 };
            }
            _ => {}
        }
    }
    0
}

/// Flatten the injected TEXT of a message content block (string, `{type:text}`, tool_result text).
/// tool_use inputs and base64 image data are deliberately ignored — the former is stable history,
/// the latter is never touched (pointer-only). Returns `""` for a non-text block.
fn message_block_text(b: &Value) -> String {
    let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
    if ty == "text" {
        if let Some(t) = b.get("text").and_then(Value::as_str) {
            return t.to_owned();
        }
    }
    if ty == "tool_result" {
        match b.get("content") {
            Some(Value::String(c)) => return c.clone(),
            Some(Value::Array(a)) => {
                let parts: Vec<String> = a
                    .iter()
                    .map(|x| match if is_js_object(x) { x.get("text") } else { None } {
                        Some(t) if truthy(t) => js_string(t),
                        _ => String::new(),
                    })
                    .collect();
                return parts.join("\n");
            }
            _ => {}
        }
    }
    String::new()
}

/// Parse a raw request body into a compact, pointer-only `TurnPrefix`. The cached prefix = the whole
/// tools array + the whole system array + the message blocks up to and including the LAST
/// message-level `cache_control` breakpoint (everything after that is the volatile current-turn
/// tail, expected to change, and excluded from the break diff). `None` for an unparseable body.
pub fn extract_turn_prefix(body: Option<&Value>) -> Option<TurnPrefix> {
    // `!body || typeof body !== 'object'` — null is rejected, an ARRAY is not (typeof [] === 'object').
    let body = body.filter(|v| is_js_object(v))?;
    let model = body.get("model").and_then(Value::as_str).unwrap_or("").to_owned();

    // Whole-request counters for the no-cache-activity diagnosis (CACHING_DISABLED /
    // BELOW_MIN_CACHEABLE). Accumulated during the passes we already make — a separate walk would
    // re-traverse a multi-MB body for two integers.
    let mut cc_markers: u32 = 0;
    let mut prompt_bytes: u64 = 0;

    let mut tools: Vec<PrefixTool> = Vec::new();
    if let Some(arr) = body.get("tools").and_then(Value::as_array) {
        for t in arr {
            let name = t.get("name").and_then(Value::as_str).unwrap_or("?").to_owned();
            // NUL (U+0000) as the fingerprint field separator (no description/schema can contain
            // it) — ALWAYS spelled as the escape, never a raw 0x00 byte: a raw NUL in the source
            // makes grep/file/diff classify the whole file as binary (bitten 2026-07-16).
            let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
            let schema = t.get("input_schema").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({}));
            let def_bytes = format!("{desc}\u{0}{}", serde_json::to_string(&schema).unwrap_or_default());
            prompt_bytes += def_bytes.len() as u64;
            if t.get("cache_control").is_some_and(truthy) {
                cc_markers += 1;
            }
            tools.push(PrefixTool {
                deferred: t.get("defer_loading") == Some(&Value::Bool(true)),
                is_mcp: name.starts_with("mcp__"),
                fp: fnv1a(&def_bytes),
                name,
            });
        }
    }

    let mut system_blocks: Vec<PrefixBlock> = Vec::new();
    let mut system_texts: Vec<&str> = Vec::new();
    match body.get("system") {
        Some(Value::String(s)) if !s.is_empty() => {
            system_texts.push(s);
            prompt_bytes += s.len() as u64;
            for seg in segment_injected(s, "system prompt") {
                system_blocks.push(to_prefix_block(Layer::System, seg.kind, seg.label, seg.text));
            }
        }
        Some(Value::Array(arr)) => {
            for (i, s) in arr.iter().enumerate() {
                if s.get("cache_control").is_some_and(truthy) {
                    cc_markers += 1;
                }
                let text = s.get("text").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                system_texts.push(text);
                prompt_bytes += text.len() as u64;
                for seg in segment_injected(text, &format!("system[{i}]")) {
                    system_blocks.push(to_prefix_block(Layer::System, seg.kind, seg.label, seg.text));
                }
            }
        }
        _ => {}
    }

    // Message cached prefix: find the LAST message index that carries (or whose content carries) a
    // cache_control marker — the cache breakpoint. Everything up to and including it is cached
    // prefix. The SAME pass totals the prompt over EVERY message, not just the prefix: a request
    // whose only breakpoint sits in system[] has an EMPTY message prefix, and sizing the prompt
    // from that would report ~0 tokens for a huge conversation and fire BELOW_MIN_CACHEABLE on it.
    static NO_MESSAGES: OnceLock<Vec<Value>> = OnceLock::new();
    let messages: &Vec<Value> = body
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or_else(|| NO_MESSAGES.get_or_init(Vec::new));
    let mut last_breakpoint: i64 = -1;
    for (i, mm) in messages.iter().enumerate() {
        match mm.get("content") {
            Some(Value::String(c)) => {
                prompt_bytes += c.len() as u64;
            }
            Some(Value::Array(c)) => {
                let mut has_cc = false;
                for b in c {
                    if !is_js_object(b) {
                        continue;
                    }
                    if b.get("cache_control").is_some_and(truthy) {
                        has_cc = true;
                        cc_markers += 1;
                    }
                    prompt_bytes += message_block_text_bytes(b);
                }
                if has_cc {
                    last_breakpoint = i as i64;
                }
            }
            _ => {}
        }
    }

    let mut message_blocks: Vec<PrefixBlock> = Vec::new();
    for (i, mm) in messages.iter().enumerate().take(usize::try_from(last_breakpoint + 1).unwrap_or(0)) {
        let role = mm.get("role").and_then(Value::as_str).unwrap_or("");
        match mm.get("content") {
            Some(Value::String(content)) => {
                if content.is_empty() {
                    continue;
                }
                // Plain conversation history rarely carries injected markers → `usertext` segments
                // are stable history; kept so a genuine reorder/compaction is still visible, but
                // they classify as UNCLASSIFIED (never falsely blamed for a specific cause).
                for seg in segment_injected(content, &format!("msg[{i}] {role}")) {
                    message_blocks.push(to_prefix_block(Layer::Message, seg.kind, seg.label, seg.text));
                }
            }
            Some(Value::Array(content)) => {
                for b in content {
                    if !is_js_object(b) {
                        continue;
                    }
                    let text = message_block_text(b);
                    if text.is_empty() {
                        if let Some(att) = attachment_prefix_block(b, i) {
                            message_blocks.push(att);
                        }
                        continue;
                    }
                    for seg in segment_injected(&text, &format!("msg[{i}] {role}")) {
                        message_blocks.push(to_prefix_block(Layer::Message, seg.kind, seg.label, seg.text));
                    }
                }
            }
            _ => {}
        }
    }

    let system_text = system_texts.join("\n");
    let env_region = extract_env_region(&system_text);
    let git_region = extract_git_region(&system_text);

    Some(TurnPrefix {
        model,
        thinking: param_signature(body.get("thinking")),
        effort_param: effort_param_of(body),
        tool_choice: param_signature(body.get("tool_choice")),
        speed: param_signature(body.get("speed")),
        env_fp: if env_region.is_empty() { String::new() } else { fnv1a(env_region) },
        env_norm: if env_region.is_empty() { String::new() } else { fnv1a(&normalize_volatile(env_region)) },
        git_fp: if git_region.is_empty() { String::new() } else { fnv1a(git_region) },
        git_norm: if git_region.is_empty() { String::new() } else { fnv1a(&normalize_volatile(git_region)) },
        has_cache_control: cc_markers > 0,
        prompt_tokens_approx: estimate_tokens_from_bytes(prompt_bytes),
        message_count: messages.len(),
        tools,
        system_blocks,
        message_blocks,
    })
}
