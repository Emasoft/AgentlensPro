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

use crate::summarize::helpers::{fmt_js_num, js_slice, js_string, js_to_fixed_str, to_locale_en, truthy, utf16_len};
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
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
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

// ── The classifier (SLICE 2 of 4, TS lines 637-1010) ─────────────────────────────
/// Where the culprit lives. Distinct from `Layer` (which only labels a prefix BLOCK): a verdict can
/// blame the model, the request parameters, or pure timing, none of which are block layers.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CulpritLayer {
    Model,
    Effort,
    Tools,
    System,
    Message,
    Timing,
}

impl CulpritLayer {
    pub fn id(self) -> &'static str {
        match self {
            CulpritLayer::Model => "model",
            CulpritLayer::Effort => "effort",
            CulpritLayer::Tools => "tools",
            CulpritLayer::System => "system",
            CulpritLayer::Message => "message",
            CulpritLayer::Timing => "timing",
        }
    }
}

pub struct CacheBreakVerdict {
    pub cause: TimelineCause,
    pub culprit_layer: CulpritLayer,
    /// STABLE identity of the offending element — the grouping key for the repeat-offender rollup.
    pub culprit_id: String,
    /// Pointer-only, human-readable — never full content.
    pub culprit_summary: String,
    pub ttl_tier: Option<TtlTier>,
    /// Attached only for UNCLASSIFIED.
    pub raw_diff_summary: Option<String>,
    /// Set for PLUGINS_RELOADED: high = 3 catalogs churned, medium = 2.
    pub confidence: Option<&'static str>,
}

impl CacheBreakVerdict {
    fn new(cause: TimelineCause, layer: CulpritLayer, id: String, summary: String) -> Self {
        Self { cause, culprit_layer: layer, culprit_id: id, culprit_summary: summary, ttl_tier: None, raw_diff_summary: None, confidence: None }
    }

    fn with_tier(mut self, tier: TtlTier) -> Self {
        self.ttl_tier = Some(tier);
        self
    }

    /// The four required keys always come first, in the TS literal order, and each optional key is
    /// OMITTED when absent — a TS optional property is not a null, and no branch sets two of them,
    /// so this one order reproduces every construction site in the file.
    pub fn to_value(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("cause".into(), Value::String(self.cause.id().to_owned()));
        m.insert("culpritLayer".into(), Value::String(self.culprit_layer.id().to_owned()));
        m.insert("culpritId".into(), Value::String(self.culprit_id.clone()));
        m.insert("culpritSummary".into(), Value::String(self.culprit_summary.clone()));
        if let Some(t) = self.ttl_tier {
            m.insert("ttlTier".into(), Value::String(t.id().to_owned()));
        }
        if let Some(r) = &self.raw_diff_summary {
            m.insert("rawDiffSummary".into(), Value::String(r.clone()));
        }
        if let Some(c) = self.confidence {
            m.insert("confidence".into(), Value::String(c.to_owned()));
        }
        Value::Object(m)
    }
}

#[derive(Clone, Copy, Default)]
pub struct BreakTiming {
    pub gap_ms: Option<f64>,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub ephemeral_5m_tokens: f64,
    pub ephemeral_1h_tokens: f64,
    /// Blocks appended since the last turn that actually WROTE to the cache — the distance the
    /// 20-block lookback window has to cover. `None` when no write has been observed yet in this
    /// stream. Counted in MESSAGES, the conservative unit: a message contributes at least one
    /// content block, so "≥20 messages" guarantees "≥20 blocks" and the detector can only fire
    /// LATE, never early.
    pub blocks_added_since_last_write: Option<f64>,
}

const FIVE_MIN: f64 = 5.0 * 60_000.0;
const ONE_HOUR: f64 = 60.0 * 60_000.0;
/// "The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint,
/// counting the breakpoint itself as the first." — API prompt-caching docs, quoted in
/// reports/cache-invalidation-research/20260804_142700+0200-prompt-caching-docs.md (A-13).
const LOOKBACK_WINDOW_BLOCKS: f64 = 20.0;

fn fmt_list<S: AsRef<str>>(xs: &[S]) -> String {
    let all: Vec<&str> = xs.iter().map(AsRef::as_ref).collect();
    if all.len() <= 3 {
        all.join(", ")
    } else {
        format!("{} +{} more", all[..3].join(", "), all.len() - 3)
    }
}

fn mk_tools(cause: TimelineCause, names: &[&str], summary: String) -> CacheBreakVerdict {
    // `.slice(0, 3).sort()` — the FIRST three by arrival, then sorted. Sorting first would pick a
    // different three and change the grouping key for the repeat-offender rollup.
    let mut first3: Vec<&str> = names.iter().take(3).copied().collect();
    first3.sort_unstable();
    CacheBreakVerdict::new(cause, CulpritLayer::Tools, format!("tools:{}:{}", cause.id(), first3.join(",")), summary)
}

/// Diff the tools layer: added/removed by set, then order, then per-tool definition change. Returns
/// the most-specific tools cause, or `None` when the tool catalog is byte-identical.
fn diff_tools(prev: &TurnPrefix, cur: &TurnPrefix) -> Option<CacheBreakVerdict> {
    let prev_names: Vec<&str> = prev.tools.iter().map(|t| t.name.as_str()).collect();
    let cur_names: Vec<&str> = cur.tools.iter().map(|t| t.name.as_str()).collect();
    let prev_set: HashSet<&str> = prev_names.iter().copied().collect();
    let cur_set: HashSet<&str> = cur_names.iter().copied().collect();
    let added: Vec<&str> = cur_names.iter().copied().filter(|n| !prev_set.contains(n)).collect();
    let removed: Vec<&str> = prev_names.iter().copied().filter(|n| !cur_set.contains(n)).collect();

    if !added.is_empty() || !removed.is_empty() {
        let changed: Vec<&str> = added.iter().chain(removed.iter()).copied().collect();
        // A newly-present DEFERRED tool (and no removals) = tool-search deferred loading.
        let added_deferred = added
            .iter()
            .filter(|n| cur.tools.iter().find(|t| t.name == **n).is_some_and(|t| t.deferred))
            .count();
        if !added.is_empty() && removed.is_empty() && added_deferred == added.len() {
            return Some(mk_tools(
                TimelineCause::ToolSearchDeferred,
                &added,
                format!("deferred tool(s) loaded mid-session: {}", fmt_list(&added)),
            ));
        }
        // All changed tools are MCP — a server / plugin toggled. Backtrace to the SERVER(s) so the
        // culpritId groups by the connecting/disconnecting server, not the individual tool churn.
        if changed.iter().all(|n| n.starts_with("mcp__")) {
            let servers = mcp_servers_of(&changed);
            let srv_tag = if servers.is_empty() { String::new() } else { format!(" [server: {}]", fmt_list(&servers)) };
            let a = if added.is_empty() { String::new() } else { format!("added {}", fmt_list(&added)) };
            let r = if removed.is_empty() { String::new() } else { format!(" removed {}", fmt_list(&removed)) };
            let summary = format!("MCP tool(s) {a}{r}{srv_tag}").trim().to_owned();
            let server_refs: Vec<&str> = servers.iter().map(String::as_str).collect();
            let names = if servers.is_empty() { &changed } else { &server_refs };
            return Some(mk_tools(TimelineCause::McpToolsChanged, names, summary));
        }
        // The changed set is entirely harness deferred built-ins → the perpetrator is the harness
        // ToolSearch mechanism, attributed to ONE stable actor so the rollup names the harness
        // rather than the volatile add/remove list.
        if changed.iter().all(|n| is_deferred_builtin(n)) {
            return Some(mk_tools(
                TimelineCause::ToolSearchDeferred,
                &["harness:deferred-builtins"],
                format!("harness ToolSearch toggled deferred built-ins ({}): {}", changed.len(), fmt_list(&changed)),
            ));
        }
        let a = if added.is_empty() { String::new() } else { format!("added {}", fmt_list(&added)) };
        let r = if removed.is_empty() { String::new() } else { format!(" removed {}", fmt_list(&removed)) };
        return Some(mk_tools(TimelineCause::ToolsetChanged, &changed, format!("tool(s) {a}{r}").trim().to_owned()));
    }

    // Same set: order change? NUL join, so a name containing the separator cannot forge a match.
    if cur_names.join("\u{0}") != prev_names.join("\u{0}") {
        // `prevNames[i]` is `undefined` past the end, which is never equal to a name — so a
        // same-SET pair of different LENGTHS (duplicate names) diverges at the overrun, as in JS.
        let first_moved = cur_names
            .iter()
            .enumerate()
            .find(|(i, n)| prev_names.get(*i) != Some(*n))
            .map_or_else(|| cur_names.first().copied().unwrap_or(""), |(_, n)| *n);
        return Some(mk_tools(
            TimelineCause::ToolsReordered,
            &[first_moved],
            format!("same {} tools, order changed (first at \"{first_moved}\")", cur_names.len()),
        ));
    }
    // Same set + order: a tool DEFINITION (description/schema) changed?
    for t in &cur.tools {
        if let Some(p) = prev.tools.iter().find(|x| x.name == t.name) {
            if p.fp != t.fp {
                return Some(mk_tools(
                    TimelineCause::ToolsetChanged,
                    &[t.name.as_str()],
                    format!("tool definition changed: {}", t.name),
                ));
            }
        }
    }
    None
}

/// Did the blocks of ONE content kind (skillcatalog, agentcatalog) change between two turns? A set
/// diff by fingerprint — a plugin reload re-registers a whole catalog, so its fp-set shifts. Used
/// only by the cross-layer reload detector. (TRDD-EYA3X5MQ)
fn catalog_kind_churned(prev: &[PrefixBlock], cur: &[PrefixBlock], kind: BlockContentKind) -> bool {
    let fps = |bs: &[PrefixBlock]| {
        let mut v: Vec<&str> = bs.iter().filter(|b| b.kind == kind).map(|b| b.fp.as_str()).collect();
        v.sort_unstable();
        v.join("|")
    };
    fps(prev) != fps(cur)
}

fn mk_block(cause: TimelineCause, layer: CulpritLayer, b: &PrefixBlock, summary: String) -> CacheBreakVerdict {
    CacheBreakVerdict::new(
        cause,
        layer,
        format!("{}:{}:{}:{}", layer.id(), cause.id(), b.kind.id(), js_slice(&b.label, 48)),
        summary,
    )
}

/// Diff a block layer POSITIONALLY — the prompt cache breaks at the first differing BYTE position,
/// so the first differing block POSITION in the cached prefix is the true break point. This is what
/// makes normal conversation GROWTH not a false break: appended blocks beyond the previous prefix's
/// length are ignored (that is the one-time cache_creation of new content, expected); only a
/// change/removal/reorder WITHIN the previously-cached common prefix is an avoidable break.
fn diff_blocks(prev_raw: &[PrefixBlock], cur_raw: &[PrefixBlock], layer: CulpritLayer) -> Option<CacheBreakVerdict> {
    // Drop cache-transparent blocks BEFORE the positional diff. The harness billing header (kind
    // `agentmeta` — the leading `cc_prev_req` block at system pos 0) changes on EVERY turn but is
    // EXCLUDED from Anthropic's prompt-cache key. Proven empirically: were it in the key, every
    // turn would rewrite the whole prefix as cache_creation (it always changes), yet long sessions
    // measure >95% cache_read. So a divergence there is NOT a real break — comparing it would pin
    // every idle-TTL / message-prefix / sub-agent break on a constant ("billing header"), the exact
    // false-SYSTEMATIC verdict this masks.
    // NOTE: `agentcatalog` (the agent-types list) is a DIFFERENT kind and IS cache-relevant.
    let prev_blocks: Vec<&PrefixBlock> = prev_raw.iter().filter(|b| b.kind != BlockContentKind::AgentMeta).collect();
    let cur_blocks: Vec<&PrefixBlock> = cur_raw.iter().filter(|b| b.kind != BlockContentKind::AgentMeta).collect();
    let prev_fps: HashSet<&str> = prev_blocks.iter().map(|b| b.fp.as_str()).collect();
    let cur_fps: HashSet<&str> = cur_blocks.iter().map(|b| b.fp.as_str()).collect();
    let prev_kinds: HashSet<BlockContentKind> = prev_blocks.iter().map(|b| b.kind).collect();

    let n = prev_blocks.len().min(cur_blocks.len());
    for i in 0..n {
        let (p, c) = (prev_blocks[i], cur_blocks[i]);
        if p.fp == c.fp {
            continue;
        }
        // First divergence at position i. Classify most-specific-first.
        if c.kind == BlockContentKind::PostCompact || p.kind == BlockContentKind::PostCompact {
            return Some(mk_block(
                TimelineCause::Compaction,
                layer,
                c,
                format!("conversation compaction rebuilt the {} prefix at {}", layer.id(), c.label),
            ));
        }
        if p.norm == c.norm {
            return Some(mk_block(TimelineCause::SystemTimestamp, layer, c, format!("moving date/clock in {}", c.label)));
        }
        // msg[0] carries the CONVERSATION'S IDENTITY, and its `usertext` segment is the caller's own
        // opening words — immutable within one conversation. A divergence THERE does not mean a
        // block changed; it means these two requests are different conversations sharing a session
        // id, which is the norm for sub-agents (their calls carry the PARENT's id). Nothing broke.
        //
        // Measured over 2,003 consecutive real turn-pairs (TRDD-00NOBU9W): 397 diverge first
        // exactly here, every sampled one a different sub-agent TASK PROMPT — they were landing in
        // UNCLASSIFIED, which then ranked as the "Dominant AVOIDABLE perpetrator" at 23.2%.
        //
        // The KIND is the load-bearing part: CLAUDE.md, the rules and the memory index are injected
        // INTO msg[0] and DO change mid-conversation (a memory rewrite alone was 19% of classified
        // break tokens here). Those carry their own kinds, so requiring `usertext` on BOTH sides
        // leaves every one of them exactly where it was.
        if layer == CulpritLayer::Message
            && c.label.starts_with("msg[0]")
            && c.kind == BlockContentKind::UserText
            && p.kind == BlockContentKind::UserText
        {
            return Some(CacheBreakVerdict::new(
                TimelineCause::SubagentInterleave,
                CulpritLayer::Message,
                "interleave:root-differs".to_owned(),
                "msg[0]'s own prompt text differs — these two requests are DIFFERENT conversations sharing one session id (a sub-agent's calls carry the parent's session id), so neither one broke the other's cache".to_owned(),
            ));
        }
        // Same content, different position → a pure reorder, not a content change.
        if prev_fps.contains(c.fp.as_str()) && cur_fps.contains(p.fp.as_str()) {
            return Some(CacheBreakVerdict::new(
                TimelineCause::ContextOrderChanged,
                layer,
                format!("{}:order", layer.id()),
                format!("{} blocks reordered at {} (identical content, different order)", layer.id(), c.label),
            ));
        }
        // Skill-catalog specifics, deliberately BEFORE the generic insertion detector — a spliced-in
        // skill catalog is still SKILL_INJECTION (the more specific verdict), and running the
        // generic branch first demoted it to SKILL_CHANGED, which an existing test caught.
        if c.kind == BlockContentKind::SkillCatalog {
            if !prev_kinds.contains(&BlockContentKind::SkillCatalog) {
                return Some(mk_block(TimelineCause::SkillInjection, layer, c, format!("skill catalog injected at pos {i}: {}", c.label)));
            }
            if p.kind == BlockContentKind::SkillCatalog && (c.len as f64) < (p.len as f64) * 0.9 {
                return Some(mk_block(
                    TimelineCause::SkillDescriptionTruncation,
                    layer,
                    c,
                    format!("skill catalog shrank {}→{} chars: {}", p.len, c.len, c.label),
                ));
            }
        }
        // An INSERTION, not a change: something was spliced in front of prev's block here, shifting
        // it down. Measured incident (2026-08-13T01:08:10Z, 453,881 tokens): the harness spliced a
        // standalone role:"system" hook message into the middle of `messages`, shifting every later
        // message +1. Reporting that as "<kind> block changed" misattributes the break to the
        // SHIFTED bystander and manufactures an UNCLASSIFIED with the real actor unnamed.
        //
        // TWO conditions, both load-bearing: the COUNT guard, because an insertion grows the block
        // list while an in-place rewrite keeps it — and the fp sets are content-only, so a rewrite
        // X→Y with a byte-identical copy of X elsewhere satisfied a set-membership test and
        // reported a splice for a turn where nothing shifted; and the POSITIONAL lookahead, because
        // "the very next cur block is exactly prev's block at this position" IS the shift.
        if cur_blocks.len() > prev_blocks.len() && cur_blocks.get(i + 1).is_some_and(|b| b.fp == p.fp) {
            let inserted = cause_for_content_kind(c.kind);
            // A recognised kind keeps its own cause (the ACTOR is named); content no matcher knows
            // still gets the STRUCTURE named — MESSAGE_SPLICED, never UNCLASSIFIED, and never
            // CONTEXT_ORDER_CHANGED, whose "identical content" claim would be false here.
            let cause = if inserted == TimelineCause::Unclassified { TimelineCause::MessageSpliced } else { inserted };
            return Some(mk_block(
                cause,
                layer,
                c,
                format!(
                    "{} block spliced in at pos {i}: {} — later {} blocks shifted, invalidating everything after the splice point",
                    c.kind.id(),
                    c.label,
                    layer.id()
                ),
            ));
        }
        // The mirror image: prev's block here was REMOVED, shifting cur's up — cur[i] is exactly
        // prev[i+1]. Without this branch a mid-array trim fell to the generic "changed" verdict
        // blaming the shifted bystander. The culprit is the REMOVED block (p), never c.
        if cur_blocks.len() < prev_blocks.len() && prev_blocks.get(i + 1).is_some_and(|b| b.fp == c.fp) {
            return Some(mk_block(
                TimelineCause::MessageTrimmed,
                layer,
                p,
                format!(
                    "{} block removed at pos {i}: {} — later {} blocks shifted up (context-editing/trim), invalidating everything after the removal point",
                    p.kind.id(),
                    p.label,
                    layer.id()
                ),
            ));
        }
        let changed = cause_for_content_kind(c.kind);
        return Some(mk_block(changed, layer, c, format!("{} block changed at pos {i}: {}", c.kind.id(), c.label)));
    }

    // No divergence within the common prefix.
    if prev_blocks.len() > cur_blocks.len() {
        // The cached prefix SHRANK — a block that was cached got dropped.
        let dropped = prev_blocks[cur_blocks.len()];
        if dropped.kind == BlockContentKind::PostCompact {
            return Some(mk_block(TimelineCause::Compaction, layer, dropped, format!("compaction dropped {} blocks from {}", layer.id(), dropped.label)));
        }
        if dropped.kind == BlockContentKind::SkillCatalog {
            return Some(mk_block(TimelineCause::SkillChanged, layer, dropped, format!("skill catalog removed from the {} prefix: {}", layer.id(), dropped.label)));
        }
        // A plain conversation/tool block dropped from the MESSAGE prefix = harness context-editing
        // / tool-result clearing / message deletion — a named cause, not UNCLASSIFIED.
        if layer == CulpritLayer::Message
            && matches!(
                dropped.kind,
                BlockContentKind::UserText | BlockContentKind::History | BlockContentKind::Attachment | BlockContentKind::ExecResult
            )
        {
            return Some(mk_block(
                TimelineCause::MessageTrimmed,
                layer,
                dropped,
                format!("{} block removed from the message prefix (context-editing/trim): {}", dropped.kind.id(), dropped.label),
            ));
        }
        return Some(mk_block(
            cause_for_content_kind(dropped.kind),
            layer,
            dropped,
            format!("{} block removed from the {} prefix: {}", dropped.kind.id(), layer.id(), dropped.label),
        ));
    }
    // cur is longer (pure append growth) or identical — NOT an avoidable break.
    None
}

/// The two causes that are NOT a break at all but a turn that was never cached in the first place —
/// both counters 0. Returns `None` the moment there is ANY cache activity, so it can never displace
/// a real break verdict.
fn diagnose_no_cache_activity(cur: &TurnPrefix, timing: &BreakTiming) -> Option<CacheBreakVerdict> {
    if timing.cache_create_tokens != 0.0 || timing.cache_read_tokens != 0.0 {
        return None;
    }
    // No marker anywhere ⇒ nothing was ever offered to the cache. Checked FIRST: such a request is
    // often also below the minimum, but "the prompt was too small" would name a condition that
    // never got the chance to apply.
    if !cur.has_cache_control {
        return Some(
            CacheBreakVerdict::new(
                TimelineCause::CachingDisabled,
                CulpritLayer::Timing,
                "config:no-cache-control".to_owned(),
                "the request carried no cache_control marker anywhere — nothing was offered to the cache".to_owned(),
            )
            .with_tier(TtlTier::None),
        );
    }
    // Markers present and STILL nothing cached: the documented silent failure. The counters are the
    // load-bearing evidence; the size check is corroboration, skipped entirely for a model we have
    // no documented minimum for.
    let min = min_cacheable_tokens_for(&cur.model)?;
    if (cur.prompt_tokens_approx as f64) < f64::from(min) {
        let model = if cur.model.is_empty() { "?" } else { &cur.model };
        return Some(
            CacheBreakVerdict::new(
                TimelineCause::BelowMinCacheable,
                CulpritLayer::Timing,
                format!("config:below-min:{model}"),
                format!(
                    "cache_control present but nothing cached: ~{} est. tokens is under this model's {}-token minimum",
                    to_locale_en(cur.prompt_tokens_approx as f64),
                    to_locale_en(f64::from(min))
                ),
            )
            .with_tier(TtlTier::None),
        );
    }
    None
}

/// Classify ONE turn's cache_creation into a root cause by diffing its prefix against the previous
/// turn's, in the docs hierarchy order (model → tools → effort → system → message-prefix). A
/// structural prefix change ALWAYS beats a timing gap — the change is the real culprit. When the
/// prefix is byte-identical, the break is timing (TTL expiry / cold start).
pub fn classify_cache_break(
    prev: Option<&TurnPrefix>,
    cur: &TurnPrefix,
    timing: &BreakTiming,
    prev2: Option<&TurnPrefix>,
) -> CacheBreakVerdict {
    // -1. NO cache activity at all (both counters 0). Checked before everything, including the
    //     first-turn guard: calling a turn that was never eligible for caching a "cold warm" names
    //     a cache event that did not happen. Measured on the live spool: 4 of 1,377 requests carry
    //     no cache_control marker and 4 of 1,355 responses report 0/0.
    if let Some(v) = diagnose_no_cache_activity(cur, timing) {
        return v;
    }
    let Some(prev) = prev else {
        return CacheBreakVerdict::new(
            TimelineCause::ColdStart,
            CulpritLayer::Timing,
            "timing:COLD_START".to_owned(),
            "first observed turn for this session (cold cache warm)".to_owned(),
        )
        .with_tier(TtlTier::None);
    };
    // 0. Sub-agent INTERLEAVE artifact — checked BEFORE model/tools, because it explains both.
    //    Sub-agent API calls carry the PARENT's session_id, so the mtime-ordered "turn" sequence can
    //    alternate between two independent streams (parent A, child B): the diff then sees A→B→A
    //    "model switches" and 15-tools-removed-then-re-added-in-3ms "toolset churn" that never
    //    happened — each stream keeps its OWN cache.
    if let Some(prev2) = prev2 {
        let stream_fp = |p: &TurnPrefix| {
            format!("{}|{}", p.model, p.tools.iter().map(|t| format!("{}:{}", t.name, t.fp)).collect::<Vec<_>>().join(" "))
        };
        let differs_from_prev = prev.model != cur.model || stream_fp(prev) != stream_fp(cur);
        if differs_from_prev && stream_fp(cur) == stream_fp(prev2) {
            let mut pair = [
                if prev.model.is_empty() { "?" } else { &prev.model },
                if cur.model.is_empty() { "?" } else { &cur.model },
            ];
            pair.sort_unstable();
            let pair = pair.join(" <-> ");
            return CacheBreakVerdict::new(
                TimelineCause::SubagentInterleave,
                CulpritLayer::Timing,
                format!("interleave:{pair}"),
                format!("A→B→A interleave ({pair}): this request matches turn-2's stream, not turn-1's — a sub-agent's calls share the parent session id"),
            )
            .with_tier(TtlTier::None);
        }
    }
    // 1. Model — model-specific cache, invalidates everything.
    if prev.model != cur.model {
        return CacheBreakVerdict::new(
            TimelineCause::ModelSwitch,
            CulpritLayer::Model,
            "model".to_owned(),
            format!(
                "model {} → {}",
                if prev.model.is_empty() { "?" } else { &prev.model },
                if cur.model.is_empty() { "?" } else { &cur.model }
            ),
        );
    }
    // 2. Tools — invalidates tools + system + messages (higher than effort, which keeps tools
    //    cached).
    let tools_v = diff_tools(prev, cur);
    // 2a. Plugin reload — /reload-plugins re-registers the tool + skill + agent catalogs TOGETHER,
    //     churning multiple layers at once. The per-layer classifier would name only the first
    //     (usually TOOLSET_CHANGED) and hide the reload — the machine's #1 cache-break cost. Each
    //     catalog must have EXISTED in prev: a first appearance is session warmup, not a reload.
    let prev_sys_kinds: HashSet<BlockContentKind> = prev.system_blocks.iter().map(|b| b.kind).collect();
    let skill_churned = prev_sys_kinds.contains(&BlockContentKind::SkillCatalog)
        && catalog_kind_churned(&prev.system_blocks, &cur.system_blocks, BlockContentKind::SkillCatalog);
    let agent_churned = prev_sys_kinds.contains(&BlockContentKind::AgentCatalog)
        && catalog_kind_churned(&prev.system_blocks, &cur.system_blocks, BlockContentKind::AgentCatalog);
    let tools_churned = !prev.tools.is_empty() && tools_v.is_some();
    let churn: Vec<&str> = [(tools_churned, "tools"), (skill_churned, "skills"), (agent_churned, "agents")]
        .iter()
        .filter_map(|(on, name)| on.then_some(*name))
        .collect();
    if churn.len() >= 2 {
        return CacheBreakVerdict {
            confidence: Some(if churn.len() >= 3 { "high" } else { "medium" }),
            ..CacheBreakVerdict::new(
                TimelineCause::PluginsReloaded,
                CulpritLayer::Tools,
                "plugins:reloaded".to_owned(),
                format!("plugin reload — {} catalogs churned together ({})", churn.len(), churn.join(", ")),
            )
        };
    }
    if let Some(v) = tools_v {
        return v;
    }
    // 3. Request PARAMETERS rendered into the prompt. Each fires ONLY when BOTH turns carry the
    //    parameter EXPLICITLY and the two values differ. An absent↔present transition is
    //    UNDECIDABLE from captured data: the docs say "setting a parameter explicitly to its
    //    default value is equivalent to omitting it", and no page enumerates the per-model
    //    defaults. Two DIFFERENT explicit values cannot both be the default, which is exactly the
    //    case that needs no defaults table. An unnamed break is honest; a guessed one is the false
    //    positive this rule exists to prevent.
    let param_changed = |a: &str, b: &str| !a.is_empty() && !b.is_empty() && a != b;
    if param_changed(&prev.thinking, &cur.thinking) {
        return CacheBreakVerdict::new(
            TimelineCause::ThinkingConfigChanged,
            CulpritLayer::Effort,
            "param:thinking".to_owned(),
            format!("thinking {} → {}", prev.thinking, cur.thinking),
        );
    }
    if param_changed(&prev.effort_param, &cur.effort_param) {
        return CacheBreakVerdict::new(
            TimelineCause::EffortParamChanged,
            CulpritLayer::Effort,
            "param:effort".to_owned(),
            format!("output_config.effort {} → {}", prev.effort_param, cur.effort_param),
        );
    }
    if param_changed(&prev.tool_choice, &cur.tool_choice) {
        return CacheBreakVerdict::new(
            TimelineCause::ToolChoiceChanged,
            CulpritLayer::Effort,
            "param:tool_choice".to_owned(),
            format!("tool_choice {} → {}", prev.tool_choice, cur.tool_choice),
        );
    }
    if param_changed(&prev.speed, &cur.speed) {
        return CacheBreakVerdict::new(
            TimelineCause::EffortSwitch,
            CulpritLayer::Effort,
            "param:speed".to_owned(),
            format!("speed/fast-mode {} → {}", prev.speed, cur.speed),
        );
    }
    // 4. The environment and git-snapshot REGIONS of the system prompt, before the generic block
    //    diff. Both sit inside one big system block, so the positional diff could only report "that
    //    block changed" and would file two documented causes as UNCLASSIFIED. The `norm` guard runs
    //    the other way: a region differing ONLY by a timestamp is left to the block diff, which
    //    names SYSTEM_TIMESTAMP — so this pair can never steal a clock move.
    if prev.env_fp != cur.env_fp && prev.env_norm != cur.env_norm {
        let shape = if prev.env_fp.is_empty() { "appeared" } else if cur.env_fp.is_empty() { "disappeared" } else { "changed" };
        return CacheBreakVerdict::new(
            TimelineCause::WorkingDirChanged,
            CulpritLayer::System,
            "system:env-block".to_owned(),
            format!("the environment block (working directory / platform / shell / OS) {shape} between these turns"),
        );
    }
    if prev.git_fp != cur.git_fp && prev.git_norm != cur.git_norm {
        let shape = if prev.git_fp.is_empty() { "appeared" } else if cur.git_fp.is_empty() { "disappeared" } else { "changed" };
        return CacheBreakVerdict::new(
            TimelineCause::GitStateChanged,
            CulpritLayer::System,
            "system:git-snapshot".to_owned(),
            format!("the startup git snapshot (branch / status / recent commits) {shape} between these turns"),
        );
    }
    // 5. System blocks.
    if let Some(v) = diff_blocks(&prev.system_blocks, &cur.system_blocks, CulpritLayer::System) {
        return v;
    }
    // 5b. Message cached-prefix blocks. Any structural change (even an unlocalised one) beats a
    //     timing gap — a real byte change in the cached prefix is the true culprit, never TTL.
    if let Some(mut v) = diff_blocks(&prev.message_blocks, &cur.message_blocks, CulpritLayer::Message) {
        if v.cause == TimelineCause::Unclassified {
            v.raw_diff_summary = Some(format!(
                "{}; sys={} msg={} (was {})",
                v.culprit_summary,
                cur.system_blocks.len(),
                cur.message_blocks.len(),
                prev.message_blocks.len()
            ));
        }
        return v;
    }

    // 6. No localizable structural change → timing. Pure-timing means the whole cached prefix is
    //    byte-identical to the previous turn, so the only thing that could have re-written it is a
    //    TTL expiry (the entry aged out) or a cold warm.
    if let Some(gap) = timing.gap_ms {
        if gap >= ONE_HOUR {
            return CacheBreakVerdict::new(
                TimelineCause::TtlExpiry,
                CulpritLayer::Timing,
                "timing:TTL_EXPIRY:1h".to_owned(),
                format!("no prefix change; {}m gap > 1h TTL", js_to_fixed_str(gap / 60000.0, 1)),
            )
            .with_tier(TtlTier::OneHour);
        }
        // The 4.5-6m window fires BELOW the nominal 5m — a gap that only just missed the TTL is
        // still a TTL expiry, and testing `gap >= FIVE_MIN` alone would report the wrong tier.
        // Half-open, exactly like the TS `gap >= 4.5m && gap < 6m`: `Range::contains` is
        // `start <= x < end`, so the 6m edge belongs to the branch below, not to this one.
        if (4.5 * 60_000.0..6.0 * 60_000.0).contains(&gap) {
            return CacheBreakVerdict::new(
                TimelineCause::TtlExpiry,
                CulpritLayer::Timing,
                "timing:TTL_EXPIRY:5m".to_owned(),
                format!("no prefix change; {}m gap ≈ 5m TTL", js_to_fixed_str(gap / 60000.0, 1)),
            )
            .with_tier(TtlTier::FiveMin);
        }
        if gap >= FIVE_MIN {
            return CacheBreakVerdict::new(
                TimelineCause::TtlExpiry,
                CulpritLayer::Timing,
                "timing:TTL_EXPIRY:5m".to_owned(),
                format!("no prefix change; {}m gap > 5m TTL", js_to_fixed_str(gap / 60000.0, 1)),
            )
            .with_tier(TtlTier::FiveMin);
        }
    }
    // 6.4. LOOKBACK OVERFLOW — the prefix is byte-identical, yet the cache read NOTHING. The
    //      lookback only finds entries earlier requests actually WROTE, and it checks at most 20
    //      positions. `cacheRead === 0` is the discriminator against NORMAL_GROWTH, which finds its
    //      entry and reads it. Checked after the TTL gaps: when both explanations fit, an elapsed
    //      TTL is the simpler one and stays named.
    if let Some(grown) = timing.blocks_added_since_last_write {
        if grown >= LOOKBACK_WINDOW_BLOCKS && timing.cache_read_tokens == 0.0 && timing.cache_create_tokens > 0.0 {
            return CacheBreakVerdict::new(
                TimelineCause::LookbackOverflow,
                CulpritLayer::Message,
                "lookback:overflow".to_owned(),
                format!(
                    "unchanged prefix, zero cache_read: {} block(s) appended since the last cache write > the {}-block lookback window",
                    fmt_js_num(grown),
                    fmt_js_num(LOOKBACK_WINDOW_BLOCKS)
                ),
            )
            .with_tier(TtlTier::None);
        }
    }
    if timing.cache_read_tokens == 0.0 {
        return CacheBreakVerdict::new(
            TimelineCause::ColdStart,
            CulpritLayer::Timing,
            "timing:COLD_START".to_owned(),
            "no cache_read this turn — nothing cached to break (cold warm)".to_owned(),
        )
        .with_tier(TtlTier::None);
    }
    // 6.5. Pure APPEND growth: the previously-cached prefix is byte-identical AND this turn's
    //      message prefix is LONGER — the cache_creation is the NEW tail being cached for the first
    //      time. That is the incremental cache WORKING, not a break. This was the single biggest
    //      population previously dumped into UNCLASSIFIED.
    if cur.message_blocks.len() > prev.message_blocks.len() {
        let added = cur.message_blocks.len() - prev.message_blocks.len();
        return CacheBreakVerdict::new(
            TimelineCause::NormalGrowth,
            CulpritLayer::Message,
            "growth:new-tail".to_owned(),
            format!("append-only growth: +{added} new message block(s) cached for the first time (expected incremental write, not a break)"),
        )
        .with_tier(TtlTier::None);
    }
    // 7. Every layer's fingerprints matched yet a real re-write happened — an effect we cannot
    //    localise (e.g. a cache_control breakpoint moved, or an estimator blind spot). Attach a
    //    diff summary rather than guess.
    let mut v = CacheBreakVerdict::new(
        TimelineCause::Unclassified,
        CulpritLayer::Timing,
        "timing:UNCLASSIFIED".to_owned(),
        "unlocalised re-write".to_owned(),
    );
    v.raw_diff_summary = Some(format!(
        "prefix byte-identical by fingerprint but cache_creation={}; tools={} sys={} msg={}",
        fmt_js_num(timing.cache_create_tokens),
        cur.tools.len(),
        cur.system_blocks.len(),
        cur.message_blocks.len()
    ));
    v
}

// ── The bounded scan + the timeline report (SLICE 3 of 4, TS lines 1026-1649) ─────
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use agentlens_store::bodies_evidence::{list_body_evidence, load_body_texts, EvidenceFilter, EvidenceRow};
use indexmap::IndexMap;

use crate::cache_creation_forensics::{MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, RESPONSE_SCAN_CAP};
use crate::hook_events::{read_hook_events, HookEventFilter};
use crate::pricing::calc_token_cost_usd;
use crate::raw_body_context::parse_user_id;
use crate::summarize::helpers::{iso_from_ms, js_math_round, js_to_fixed_num, num, pad_end, pad_start, parse_iso_ms};

pub struct CacheBreakTimelineOptions {
    /// The agentlens data dir. `bodies_dir` / `store_dir` / `hook_events_dir` default from it, the
    /// way the TS `dataPath(...)` calls do — passed in rather than resolved from a global so a test
    /// can point the whole read path at a fixture (the house rule the burn guard already follows).
    pub data_dir: PathBuf,
    pub bodies_dir: Option<PathBuf>,
    /// The Parquet body store (default `<dataDir>/store`) — the durable half of the evidence union.
    pub store_dir: Option<PathBuf>,
    pub session_id: Option<String>,
    pub scope: Option<String>,
    pub min_tokens: Option<f64>,
    pub window_hours: Option<f64>,
    pub scan_cap: Option<usize>,
    /// Cap on the returned `events` array (default 25, max 100). repeatOffenders/causeHistogram are
    /// unaffected.
    pub top_n: Option<f64>,
    /// Claude projects roots searched for a sub-agent child's transcript (test override; defaults
    /// to the same roots the log reader ingests from).
    pub projects_dirs: Option<Vec<PathBuf>>,
    /// The lifecycle hook-event store (append-only NDJSON daily buckets), default
    /// `<dataDir>/hook-events`. PreCompact/PostCompact events turn the COMPACTION cause from a
    /// text-shape inference into hook-corroborated evidence; a session with no hook coverage keeps
    /// the heuristic, tagged `inferred`.
    pub hook_events_dir: Option<PathBuf>,
}

impl CacheBreakTimelineOptions {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            bodies_dir: None,
            store_dir: None,
            session_id: None,
            scope: None,
            min_tokens: None,
            window_hours: None,
            scan_cap: None,
            top_n: None,
            projects_dirs: None,
            hook_events_dir: None,
        }
    }
}

const DEFAULT_MIN_TOKENS: f64 = 5000.0;
const SYSTEMATIC_THRESHOLD: f64 = 3.0;
const DEFAULT_EVENTS_TOPN: f64 = 25.0;
const MAX_EVENTS_TOPN: f64 = 100.0;
/// Loading stays CHUNKED (32 bodies at a time, parsed then dropped) because ~200 × ~881 KB bodies
/// in one result set is the ~176 MB memory spike this read path is suspected of killing the server
/// with (TRDD-34B9JAZK).
const EVIDENCE_LOAD_CHUNK: usize = 32;
/// A child transcript beyond this is pathological — an honest miss, never a hang.
const SUBAGENT_TRANSCRIPT_CAP: u64 = 64 * 1024 * 1024;
/// Clock slack between the hook's server-receive ts and the API call's own timestamp.
const COMPACTION_HOOK_SLACK_MS: f64 = 60_000.0;
/// A PreCompact with no matching PostCompact closes after this long (the burnGuard
/// COMPACTION_REWRITE precedent: a compaction rewrite lands within ~5min of its PreCompact).
const COMPACTION_WINDOW_FALLBACK_MS: f64 = 5.0 * 60_000.0;

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

fn num_or_0(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|f| f.is_finite()).unwrap_or(0.0)
}

fn str_or_none(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).expect("token counts are never NaN"));
    let mid = s.len() / 2;
    if s.len() % 2 == 1 {
        s[mid]
    } else {
        js_math_round((s[mid - 1] + s[mid]) / 2.0)
    }
}

struct ScannedTurn {
    #[allow(dead_code)] // carried for parity with the TS shape; the report never emits it
    body_ref: String,
    mtime_ms: f64,
    previous_message_id: Option<String>,
    #[allow(dead_code)] // slice 4's cross-session aggregator groups on it; the bucket key serves here
    session_id: Option<String>,
    account_uuid: Option<String>,
    prefix: Option<TurnPrefix>,
}

/// `inputTokens`/`outputTokens` are additive to TRDD-6TQ2FBUR's original shape — carried so the
/// cost-peak report can rank cause groups by ANY bucket, not just cache_creation.
struct ResponseUsage {
    cache_create: f64,
    cache_read: f64,
    ephemeral_5m: f64,
    ephemeral_1h: f64,
    input_tokens: f64,
    output_tokens: f64,
    model: Option<String>,
    #[allow(dead_code)] // parity with the TS shape; the single-session timeline reads the turn mtime
    ts: f64,
}

struct SessionScan {
    by_session: IndexMap<String, Vec<ScannedTurn>>,
    resp_by_id: HashMap<String, ResponseUsage>,
    coverage: Value,
}

fn parse_bounded(raw: Option<&String>, max_bytes: u64) -> Option<Value> {
    let raw = raw?;
    if raw.len() as u64 > max_bytes {
        return None;
    }
    serde_json::from_str(raw).ok()
}

/// Shared bounded scan: index every response by message id → usage, and every request into ordered
/// per-session turns.
///
/// EVIDENCE = SPOOL ∪ PARQUET STORE, not raw files alone. The raw-files-only version had a measured
/// defect that is easy to re-introduce, so it is spelled out: the ingest drain deletes a raw file
/// the moment the store provably holds it, so this scan's history SHRANK as the drain ran — the same
/// session showed 172 turns at 01:40 and 145 at 02:00 on 2026-08-13, and a $2.84 break event was
/// classifiable in the first run and nonexistent in the second.
fn scan_sessions_and_responses(
    bodies_dir: &Path,
    store_dir: &Path,
    window_hours: Option<f64>,
    scan_cap: usize,
) -> SessionScan {
    let spool: Option<&Path> = if bodies_dir.exists() { Some(bodies_dir) } else { None };
    let ts_from_ms = window_hours.filter(|h| *h > 0.0).map(|h| now_ms() - h * 3_600_000.0);
    let list = |kind: &str| -> Vec<EvidenceRow> {
        list_body_evidence(
            store_dir,
            spool,
            &EvidenceFilter { kind: Some(kind.to_owned()), ts_from_ms, ..EvidenceFilter::default() },
        )
        .unwrap_or_default()
    };
    let mut req_all = list("request");
    let mut resp_all = list("response");

    // Store rows carry the capture ts; a spool row's ts is unknown until parsed, so stamp its file
    // mtime (the spool is small by construction — the drain keeps it at current inflow, never
    // history). A row whose file vanished mid-scan (drained) keeps ts NONE — NOT `now`, which
    // FABRICATED a capture ts and pulled a stale drained call into live windows. Null rows are
    // excluded from any window below and sort last unwindowed.
    let stamp = |rows: &mut [EvidenceRow]| {
        let Some(spool) = spool else { return };
        for r in rows.iter_mut() {
            if r.ts_ms.is_some() {
                continue;
            }
            if let Ok(md) = std::fs::metadata(spool.join(&r.src_name)) {
                if let Ok(t) = md.modified() {
                    if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                        r.ts_ms = Some(d.as_millis() as f64);
                    }
                }
            }
        }
    };
    stamp(&mut req_all);
    stamp(&mut resp_all);

    let recent = |rows: &[EvidenceRow]| -> (Vec<EvidenceRow>, usize) {
        let matched: Vec<EvidenceRow> = match ts_from_ms {
            None => rows.to_vec(),
            Some(from) => rows.iter().filter(|r| r.ts_ms.is_some_and(|t| t >= from)).cloned().collect(),
        };
        let mut sorted = matched.clone();
        // Descending by ts; a null ts sorts as 0, i.e. last — the TS `(b.tsMs ?? 0) - (a.tsMs ?? 0)`.
        sorted.sort_by(|a, b| {
            b.ts_ms.unwrap_or(0.0).partial_cmp(&a.ts_ms.unwrap_or(0.0)).expect("stamped ts are never NaN")
        });
        sorted.truncate(scan_cap);
        (sorted, matched.len())
    };
    let (req_slice, req_matched) = recent(&req_all);
    let (resp_slice, _) = recent(&resp_all);

    // Index responses by message id → usage. Chunked load: each chunk's texts are dropped before
    // the next chunk is fetched, so peak memory is EVIDENCE_LOAD_CHUNK bodies, never the corpus.
    let mut resp_by_id: HashMap<String, ResponseUsage> = HashMap::new();
    for chunk in resp_slice.chunks(EVIDENCE_LOAD_CHUNK) {
        let mut owned = chunk.to_vec();
        let texts = load_body_texts(store_dir, spool, &mut owned, EVIDENCE_LOAD_CHUNK).unwrap_or_default();
        for row in &owned {
            let Some(body) = parse_bounded(texts.get(&row.src_name), MAX_RESPONSE_BYTES) else { continue };
            let id = str_or_none(body.get("id"));
            let usage = body.get("usage");
            let (Some(id), Some(usage)) = (id, usage.filter(|u| truthy(u))) else { continue };
            let tier = usage.get("cache_creation");
            resp_by_id.insert(
                id,
                ResponseUsage {
                    cache_create: num_or_0(usage.get("cache_creation_input_tokens")),
                    cache_read: num_or_0(usage.get("cache_read_input_tokens")),
                    ephemeral_5m: num_or_0(tier.and_then(|t| t.get("ephemeral_5m_input_tokens"))),
                    ephemeral_1h: num_or_0(tier.and_then(|t| t.get("ephemeral_1h_input_tokens"))),
                    input_tokens: num_or_0(usage.get("input_tokens")),
                    output_tokens: num_or_0(usage.get("output_tokens")),
                    model: str_or_none(body.get("model")),
                    ts: row.ts_ms.unwrap_or_else(now_ms),
                },
            );
        }
    }

    // Parse requests → compact turns, grouped by session. Same chunk discipline.
    let mut by_session: IndexMap<String, Vec<ScannedTurn>> = IndexMap::new();
    for chunk in req_slice.chunks(EVIDENCE_LOAD_CHUNK) {
        let mut owned = chunk.to_vec();
        let texts = load_body_texts(store_dir, spool, &mut owned, EVIDENCE_LOAD_CHUNK).unwrap_or_default();
        for row in &owned {
            let Some(body) = parse_bounded(texts.get(&row.src_name), MAX_REQUEST_BYTES) else { continue };
            let uid = parse_user_id(body.get("metadata").and_then(|m| m.get("user_id")).unwrap_or(&Value::Null));
            let sid = uid.session_id.clone().unwrap_or_else(|| "(no-session)".to_owned());
            let turn = ScannedTurn {
                body_ref: match (row.location.as_str(), spool) {
                    ("spool", Some(s)) => s.join(&row.src_name).to_string_lossy().into_owned(),
                    _ => format!("store:{}", row.body_id.clone().unwrap_or_else(|| row.src_name.clone())),
                },
                mtime_ms: row.ts_ms.unwrap_or_else(now_ms),
                previous_message_id: str_or_none(body.get("diagnostics").and_then(|d| d.get("previous_message_id"))),
                session_id: uid.session_id,
                account_uuid: uid.account_uuid,
                prefix: extract_turn_prefix(Some(&body)),
            };
            by_session.entry(sid).or_default().push(turn);
        }
    }

    let complete = req_slice.len() == req_matched;
    let from_store = req_slice.iter().filter(|r| r.location == "store").count();
    let sessions_found = by_session.len();
    let window_phrase = match window_hours {
        Some(h) if h != 0.0 => format!(" in the last {}h", fmt_js_num(h)),
        _ => String::new(),
    };
    let note = if complete {
        format!(
            "Scanned all {req_matched} request body(ies){window_phrase} across {sessions_found} session(s) — {from_store} from the Parquet store, {} from the raw spool (drained history stays in evidence).",
            req_slice.len() - from_store
        )
    } else {
        format!(
            "SAMPLE: {} most-recent of {req_matched} matching request body(ies) across {sessions_found} session(s) (cap {scan_cap}; {from_store} store / {} spool). Not full history.",
            req_slice.len(),
            req_slice.len() - from_store
        )
    };
    let coverage = coverage_value(
        bodies_dir,
        spool.is_some(),
        req_all.len(),
        req_slice.len(),
        resp_all.len(),
        resp_slice.len(),
        sessions_found,
        scan_cap,
        window_hours,
        complete,
        note,
    );
    SessionScan { by_session, resp_by_id, coverage }
}

#[allow(clippy::too_many_arguments)] // one wire object, one construction site — the TS literal
fn coverage_value(
    bodies_dir: &Path,
    dir_exists: bool,
    request_files_total: usize,
    request_files_scanned: usize,
    response_files_total: usize,
    response_files_scanned: usize,
    sessions_found: usize,
    scan_cap: usize,
    window_hours: Option<f64>,
    complete: bool,
    note: String,
) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("bodiesDir".into(), Value::String(bodies_dir.to_string_lossy().into_owned()));
    m.insert("dirExists".into(), Value::Bool(dir_exists));
    m.insert("requestFilesTotal".into(), num(request_files_total as f64));
    m.insert("requestFilesScanned".into(), num(request_files_scanned as f64));
    m.insert("responseFilesTotal".into(), num(response_files_total as f64));
    m.insert("responseFilesScanned".into(), num(response_files_scanned as f64));
    m.insert("sessionsFound".into(), num(sessions_found as f64));
    m.insert("scanCap".into(), num(scan_cap as f64));
    // `windowHours: undefined` is DROPPED by JSON.stringify, so an absent window has no key at all.
    if let Some(h) = window_hours {
        m.insert("windowHours".into(), num(h));
    }
    m.insert("complete".into(), Value::Bool(complete));
    m.insert("note".into(), Value::String(note));
    Value::Object(m)
}

// ── agent-* child sessions ───────────────────────────────────────────────────────
// A sub-agent card's session id is `agent-<agentId>`, but the child's API calls carry the PARENT's
// session_id in metadata.user_id — so the raw-bodies scan groups every child turn under the parent,
// an exact `sessionId: 'agent-…'` lookup matched nothing, and every child timeline came back
// turnsClassified 0. The child's OWN transcript holds the missing link: its assistant `message.id`s
// ARE the child's API response ids, and turn i+1 of the same stream carries turn i's response id as
// previous_message_id.
fn find_subagent_transcript(file_name: &str, projects_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in projects_dirs {
        let Ok(projects) = std::fs::read_dir(dir) else { continue };
        for proj in projects.flatten() {
            let Ok(entries) = std::fs::read_dir(proj.path()) else { continue };
            for e in entries.flatten() {
                // Session dirs only — .jsonl siblings can never contain subagents/.
                if !e.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let candidate = e.path().join("subagents").join(file_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

struct SubagentStream {
    /// The bucket the indices below belong to. Carried EXPLICITLY: re-finding the parent by any
    /// property of the index list (its length, its max) is guesswork that happens to work until a
    /// second session of a similar size exists — measured, when adding an unrelated 4-turn session
    /// silently re-pointed this at the wrong bucket.
    parent_session_id: String,
    turns: Vec<usize>,
    note: String,
}

/// Resolve `agent-<agentId>` to the subset of the PARENT's scanned turns that belong to the child.
/// Returns INDICES into the parent's turn list (the turns themselves stay owned by `by_session`).
fn resolve_subagent_stream(
    session_id: &str,
    by_session: &IndexMap<String, Vec<ScannedTurn>>,
    projects_dirs: &[PathBuf],
) -> Option<SubagentStream> {
    // Accept both the served card id (`agent-<agentId>`) and the bare agentId a spawn placeholder uses.
    let file_name = if session_id.starts_with("agent-") {
        format!("{session_id}.jsonl")
    } else {
        format!("agent-{session_id}.jsonl")
    };
    let transcript = find_subagent_transcript(&file_name, projects_dirs)?;
    if std::fs::metadata(&transcript).ok()?.len() > SUBAGENT_TRANSCRIPT_CAP {
        return None;
    }
    let raw = std::fs::read_to_string(&transcript).ok()?;
    // The child's assistant message ids ARE its API response ids (verified byte-exact on real data).
    let mut ids: HashSet<String> = HashSet::new();
    for line in raw.split('\n') {
        if !line.contains("\"id\":\"msg_") {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if e.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(id) = e.get("message").and_then(|m| m.get("id")).and_then(Value::as_str) {
                if id.starts_with("msg_") {
                    // Owned: the parsed line is dropped at the end of the iteration. The set is one
                    // entry per child turn, so it stays small.
                    ids.insert(id.to_owned());
                }
            }
        }
    }
    // The directory that CONTAINS subagents/ IS the parent session id (deterministic, no guessing).
    let parent_session_id = transcript.parent()?.parent()?.file_name()?.to_string_lossy().into_owned();
    let parent_turns = by_session.get(&parent_session_id)?;
    if ids.is_empty() {
        return None;
    }
    // Chain membership: a request whose previous_message_id names one of the child's responses is
    // the child's NEXT call — that identifies every child turn except the stream head.
    let mut chained: Vec<usize> = parent_turns
        .iter()
        .enumerate()
        .filter(|(_, t)| t.previous_message_id.as_deref().is_some_and(|p| ids.contains(p)))
        .map(|(i, _)| i)
        .collect();
    chained.sort_by(|a, b| {
        parent_turns[*a].mtime_ms.partial_cmp(&parent_turns[*b].mtime_ms).expect("mtimes are never NaN")
    });
    if chained.is_empty() {
        return None;
    }
    // Stream-head recovery: the child's FIRST request produced its first message id but carries no
    // chain link of its own. It shares the child conversation's first message block byte-for-byte
    // with the chained turns and, being a fresh stream, has NO previous_message_id — take the
    // latest such head before the first chained turn. (A fork child inherits the parent's history,
    // so its head DOES carry a previous id and is simply not recovered; the chain still covers every
    // later turn, and classify_turns marks the earliest included turn COLD_START either way.)
    let head = &parent_turns[chained[0]];
    let head_fp = head.prefix.as_ref().and_then(|p| p.message_blocks.first()).map(|b| b.fp.clone());
    let mut turns = chained;
    if let Some(head_fp) = head_fp {
        let candidate = parent_turns
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                t.previous_message_id.is_none()
                    && t.mtime_ms < head.mtime_ms
                    && t.prefix.as_ref().and_then(|p| p.message_blocks.first()).is_some_and(|b| b.fp == head_fp)
            })
            .max_by(|(_, a), (_, b)| a.mtime_ms.partial_cmp(&b.mtime_ms).expect("mtimes are never NaN"))
            .map(|(i, _)| i);
        if let Some(c) = candidate {
            turns.insert(0, c);
        }
    }
    let note = format!(
        "Resolved '{session_id}' as a sub-agent CHILD via its subagents transcript: {} of parent {parent_session_id}'s {} scanned turn(s) belong to this child ({} child response id(s) harvested from the transcript).",
        turns.len(),
        parent_turns.len(),
        ids.len()
    );
    Some(SubagentStream { parent_session_id, turns, note })
}

// ── The timeline report ──────────────────────────────────────────────────────────
struct CacheBreakEvent {
    turn: usize,
    ts: String,
    cause: TimelineCause,
    culprit_layer: CulpritLayer,
    culprit_id: String,
    /// Pointer-only human summary.
    culprit: String,
    cache_create_tokens: f64,
    cache_read_tokens: f64,
    input_tokens: f64,
    output_tokens: f64,
    cost_usd: f64,
    gap_minutes: Option<f64>,
    ttl_tier: Option<TtlTier>,
    model: Option<String>,
    remediation: &'static str,
    raw_diff_summary: Option<String>,
    confidence: Option<&'static str>,
    /// Set ONLY on COMPACTION events. `hook` = a PreCompact/PostCompact lifecycle event for this
    /// session corroborates the compaction (positive identification); `inferred` = the
    /// prefix-diff/text-shape heuristic alone. Never present a hook-proven compaction and a
    /// lookalike as the same claim. Assigned AFTER construction, so it serializes LAST.
    cause_evidence: Option<&'static str>,
}

impl CacheBreakEvent {
    fn to_value(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("turn".into(), num(self.turn as f64));
        m.insert("ts".into(), Value::String(self.ts.clone()));
        m.insert("cause".into(), Value::String(self.cause.id().to_owned()));
        m.insert("culpritLayer".into(), Value::String(self.culprit_layer.id().to_owned()));
        m.insert("culpritId".into(), Value::String(self.culprit_id.clone()));
        m.insert("culprit".into(), Value::String(self.culprit.clone()));
        m.insert("cacheCreateTokens".into(), num(self.cache_create_tokens));
        m.insert("cacheReadTokens".into(), num(self.cache_read_tokens));
        m.insert("inputTokens".into(), num(self.input_tokens));
        m.insert("outputTokens".into(), num(self.output_tokens));
        m.insert("costUsd".into(), num(self.cost_usd));
        if let Some(g) = self.gap_minutes {
            m.insert("gapMinutes".into(), num(g));
        }
        if let Some(t) = self.ttl_tier {
            m.insert("ttlTier".into(), Value::String(t.id().to_owned()));
        }
        if let Some(mo) = &self.model {
            m.insert("model".into(), Value::String(mo.clone()));
        }
        m.insert("remediation".into(), Value::String(self.remediation.to_owned()));
        if let Some(r) = &self.raw_diff_summary {
            m.insert("rawDiffSummary".into(), Value::String(r.clone()));
        }
        if let Some(c) = self.confidence {
            m.insert("confidence".into(), Value::String(c.to_owned()));
        }
        if let Some(e) = self.cause_evidence {
            m.insert("causeEvidence".into(), Value::String(e.to_owned()));
        }
        Value::Object(m)
    }
}

/// The cache_creation billed on turn i is read from turn i's RESPONSE, whose id == turn i+1's
/// previous_message_id (the proven chain link). `None` for the last turn (no following request).
fn cc_of_turn<'a>(turns: &[&ScannedTurn], i: usize, resp_by_id: &'a HashMap<String, ResponseUsage>) -> Option<&'a ResponseUsage> {
    let next = turns.get(i + 1)?;
    let resp_id = next.previous_message_id.as_deref()?;
    resp_by_id.get(resp_id)
}

fn session_cache_create(turns: &[&ScannedTurn], resp_by_id: &HashMap<String, ResponseUsage>) -> f64 {
    (0..turns.len()).map(|i| cc_of_turn(turns, i, resp_by_id).map_or(0.0, |u| u.cache_create)).sum()
}

/// Classify every significant cache_creation turn of ONE session into a break event.
fn classify_turns(turns: &[&ScannedTurn], resp_by_id: &HashMap<String, ResponseUsage>, min_tokens: f64) -> Vec<CacheBreakEvent> {
    let mut events: Vec<CacheBreakEvent> = Vec::new();
    // The message count at the last turn that actually WROTE to the cache — the lookback window is
    // measured from the last WRITE, not from the previous turn. Updated for EVERY turn with usage,
    // including the ones the minTokens floor drops, or the distance would be measured from the last
    // *reported* write instead of the last real one.
    let mut last_write_message_count: Option<f64> = None;
    let now = now_ms();
    for i in 0..turns.len() {
        let Some(usage) = cc_of_turn(turns, i, resp_by_id) else { continue };
        let Some(cur_prefix) = turns[i].prefix.as_ref() else { continue };
        let blocks_added = last_write_message_count.map(|last| cur_prefix.message_count as f64 - last);
        let timing = BreakTiming {
            gap_ms: if i > 0 { Some(turns[i].mtime_ms - turns[i - 1].mtime_ms) } else { None },
            cache_read_tokens: usage.cache_read,
            cache_create_tokens: usage.cache_create,
            ephemeral_5m_tokens: usage.ephemeral_5m,
            ephemeral_1h_tokens: usage.ephemeral_1h,
            blocks_added_since_last_write: blocks_added,
        };
        if usage.cache_create > 0.0 {
            last_write_message_count = Some(cur_prefix.message_count as f64); // AFTER this turn's delta
        }
        // The floor is a cache_creation floor, so it drops every 0-token turn — including the ones
        // whose whole finding is that they are never cached at all. Admit exactly those two
        // diagnoses through it.
        if usage.cache_create < min_tokens && diagnose_no_cache_activity(cur_prefix, &timing).is_none() {
            continue;
        }
        let prev_prefix = if i > 0 { turns[i - 1].prefix.as_ref() } else { None };
        // For the A→B→A interleave signature.
        let prev2_prefix = if i > 1 { turns[i - 2].prefix.as_ref() } else { None };
        let gap_ms = timing.gap_ms;
        let verdict = classify_cache_break(prev_prefix, cur_prefix, &timing, prev2_prefix);
        let ev_model = usage.model.clone().or_else(|| {
            if cur_prefix.model.is_empty() { None } else { Some(cur_prefix.model.clone()) }
        });
        events.push(CacheBreakEvent {
            turn: i + 1,
            ts: iso_from_ms(turns[i].mtime_ms),
            cause: verdict.cause,
            culprit_layer: verdict.culprit_layer,
            culprit_id: verdict.culprit_id.clone(),
            culprit: verdict.culprit_summary.clone(),
            cache_create_tokens: usage.cache_create,
            cache_read_tokens: usage.cache_read,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cost_usd: ev_model.as_deref().map_or(0.0, |m| {
                js_to_fixed_num(calc_token_cost_usd(0.0, 0.0, usage.cache_create, 0.0, m, 0.0, None, now), 4)
            }),
            gap_minutes: gap_ms.map(|g| js_to_fixed_num(g / 60000.0, 1)),
            ttl_tier: verdict.ttl_tier,
            model: ev_model,
            remediation: verdict.cause.remediation(),
            raw_diff_summary: verdict.raw_diff_summary.clone(),
            confidence: verdict.confidence,
            cause_evidence: None,
        });
    }
    events
}

// ── Compaction hook evidence (TRDD-8ENYLEIO phase 3) ─────────────────────────────
// The COMPACTION cause was pure inference: a text-shape regex over msg[0]. PreCompact/PostCompact
// lifecycle hook events STATE the compaction outright, so a break they corroborate is evidence, not
// a lookalike. The heuristic stays as the fallback — tagged `inferred`, never dropped.
pub struct CompactionHookInfo {
    /// PreCompact receive times, ascending. Any one at or before an event corroborates a
    /// COMPACTION-classified break (the rebuilt prefix may first be SENT minutes later, so
    /// corroboration is precedes-based, not window-based).
    pub pre_times: Vec<f64>,
    /// `[PreCompact.ts, PostCompact.ts]` pairs (fallback close after 5min). Only a break INSIDE a
    /// window may be UPGRADED to COMPACTION.
    pub windows: Vec<(f64, f64)>,
}

/// Read PreCompact/PostCompact hook events and group them per session. Sessions without a session
/// id in the payload are dropped — corroboration must never guess whose compaction it saw.
pub fn load_compaction_hook_info(hook_events_dir: &Path) -> HashMap<String, CompactionHookInfo> {
    let mut out: HashMap<String, CompactionHookInfo> = HashMap::new();
    let read = |ev: &str| -> Vec<Value> {
        // 1000 = the reader's hard cap.
        read_hook_events(hook_events_dir, &HookEventFilter { ev: Some(ev), limit: Some(1000), ..HookEventFilter::default() })
    };
    let by_session = |recs: Vec<Value>| -> HashMap<String, Vec<f64>> {
        let mut m: HashMap<String, Vec<f64>> = HashMap::new();
        for r in recs {
            let Some(s) = r.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
            m.entry(s.to_owned()).or_default().push(num_or_0(r.get("ts")));
        }
        for arr in m.values_mut() {
            arr.sort_by(|a, b| a.partial_cmp(b).expect("hook ts are never NaN"));
        }
        m
    };
    let pre_by = by_session(read("PreCompact"));
    let post_by = by_session(read("PostCompact"));
    for (sid, pre_times) in pre_by {
        let empty: Vec<f64> = Vec::new();
        let post_times = post_by.get(&sid).unwrap_or(&empty);
        let windows = pre_times
            .iter()
            .map(|pre| (*pre, post_times.iter().copied().find(|p| *p > *pre).unwrap_or(pre + COMPACTION_WINDOW_FALLBACK_MS)))
            .collect();
        out.insert(sid, CompactionHookInfo { pre_times, windows });
    }
    out
}

/// Annotate one session's classified events with compaction hook evidence.
fn apply_compaction_hook_evidence(events: &mut [CacheBreakEvent], info: Option<&CompactionHookInfo>) {
    for e in events.iter_mut() {
        let Some(ms) = parse_iso_ms(&e.ts) else {
            if e.cause == TimelineCause::Compaction {
                e.cause_evidence = Some("inferred");
            }
            continue;
        };
        if e.cause == TimelineCause::Compaction {
            let corroborated = info.is_some_and(|i| i.pre_times.iter().any(|pre| *pre <= ms + COMPACTION_HOOK_SLACK_MS));
            e.cause_evidence = Some(if corroborated { "hook" } else { "inferred" });
        } else if e.cause == TimelineCause::Unclassified
            && info.is_some_and(|i| {
                i.windows.iter().any(|(a, b)| ms >= a - COMPACTION_HOOK_SLACK_MS && ms <= b + COMPACTION_HOOK_SLACK_MS)
            })
        {
            // Positive identification the regex missed: an unlocalized break DURING a hook-attested
            // compaction window IS the compaction. Only UNCLASSIFIED is upgraded — a named
            // mechanical cause during the window is still that cause, and overriding it would hide
            // a real misconfiguration behind an expected one. rawDiffSummary is KEPT: the upgrade
            // adds evidence, it does not erase any.
            e.cause = TimelineCause::Compaction;
            e.cause_evidence = Some("hook");
            e.remediation = TimelineCause::Compaction.remediation();
        }
    }
}

fn base_report(min_tokens: f64, coverage: Value) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("minTokens".into(), num(min_tokens));
    m.insert("systematicThreshold".into(), num(SYSTEMATIC_THRESHOLD));
    m.insert("turnsInSession".into(), num(0.0));
    m.insert("turnsClassified".into(), num(0.0));
    m.insert("totalCacheCreateTokens".into(), num(0.0));
    m.insert("events".into(), Value::Array(Vec::new()));
    m.insert("causeHistogram".into(), Value::Array(Vec::new()));
    m.insert("repeatOffenders".into(), Value::Array(Vec::new()));
    m.insert("coverage".into(), coverage);
    Value::Object(m)
}

fn build_histogram(events: &[CacheBreakEvent]) -> Value {
    let mut m: IndexMap<TimelineCause, (f64, f64)> = IndexMap::new();
    for e in events {
        let g = m.entry(e.cause).or_insert((0.0, 0.0));
        g.0 += 1.0;
        g.1 += e.cache_create_tokens;
    }
    let mut rows: Vec<(TimelineCause, f64, f64)> = m.into_iter().map(|(c, (n, t))| (c, n, t)).collect();
    // Descending by tokens. JS `sort` is STABLE, so equal-token causes keep insertion order.
    rows.sort_by(|a, b| b.2.partial_cmp(&a.2).expect("token counts are never NaN"));
    Value::Array(
        rows.into_iter()
            .map(|(cause, n, tokens)| {
                json!({ "cause": cause.id(), "events": num(n), "cacheCreateTokens": num(tokens) })
            })
            .collect(),
    )
}

/// The CHRONIC-OFFENDER rollup (the point of the tool): group break events by (cause, culprit
/// element identity) — NOT just cause — so two breaks from the SAME element are ONE recurring
/// offender. Rank by recurrence × wasted tokens; flag ≥ SYSTEMATIC_THRESHOLD-turn recurrences as
/// SYSTEMATIC with a plain-language verdict naming the exact element + its fix.
fn build_repeat_offenders(events: &[CacheBreakEvent], session_cc: f64) -> Value {
    struct Acc {
        cause: TimelineCause,
        culprit_id: String,
        culprit: String,
        tokens: Vec<f64>,
        cost: f64,
        first: usize,
        last: usize,
    }
    let mut by_key: IndexMap<String, Acc> = IndexMap::new();
    for e in events {
        let key = format!("{}::{}", e.cause.id(), e.culprit_id);
        let a = by_key.entry(key).or_insert_with(|| Acc {
            cause: e.cause,
            culprit_id: e.culprit_id.clone(),
            culprit: e.culprit.clone(),
            tokens: Vec::new(),
            cost: 0.0,
            first: e.turn,
            last: e.turn,
        });
        a.tokens.push(e.cache_create_tokens);
        a.cost += e.cost_usd;
        a.first = a.first.min(e.turn);
        a.last = a.last.max(e.turn);
    }
    let mut rows: Vec<(f64, f64, Value)> = by_key
        .into_values()
        .map(|a| {
            let total: f64 = a.tokens.iter().sum();
            let occurrences = a.tokens.len() as f64;
            let systematic = occurrences >= SYSTEMATIC_THRESHOLD;
            let verdict = format!(
                "{}{}: {} broke the cache on {} turn(s) ({} cache_creation tokens). {}",
                if systematic { "SYSTEMATIC — " } else { "" },
                a.cause.id(),
                a.culprit,
                fmt_js_num(occurrences),
                to_locale_en(total),
                a.cause.remediation()
            );
            let row = json!({
                "cause": a.cause.id(),
                "culpritId": a.culprit_id,
                "culprit": a.culprit,
                "occurrences": num(occurrences),
                "totalCacheCreateTokens": num(total),
                "medianCacheCreateTokens": num(median(&a.tokens)),
                "totalCostUsd": num(js_to_fixed_num(a.cost, 4)),
                "pctOfSessionCacheCreate": num(if session_cc > 0.0 { js_to_fixed_num(100.0 * total / session_cc, 1) } else { 0.0 }),
                "firstTurn": num(a.first as f64),
                "lastTurn": num(a.last as f64),
                "systematic": systematic,
                "verdict": verdict,
            });
            (occurrences * total, total, row)
        })
        .collect();
    // Rank by recurrence × wasted tokens (the chronic + costly first), then by tokens.
    rows.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .expect("scores are never NaN")
            .then(b.1.partial_cmp(&a.1).expect("token counts are never NaN"))
    });
    Value::Array(rows.into_iter().map(|(_, _, row)| row).collect())
}

fn build_report_for_session(
    sid: &str,
    turns: &[&ScannedTurn],
    resp_by_id: &HashMap<String, ResponseUsage>,
    min_tokens: f64,
    coverage: Value,
    top_n: Option<f64>,
    hook_info: Option<&CompactionHookInfo>,
) -> Value {
    let session_cc = session_cache_create(turns, resp_by_id);
    let mut events = classify_turns(turns, resp_by_id, min_tokens);
    apply_compaction_hook_evidence(&mut events, hook_info);
    let account_uuid = turns.iter().find_map(|t| t.account_uuid.clone());
    let model = events.iter().find_map(|e| e.model.clone());

    // Bound the returned `events` log to the most recent topN — histogram/repeatOffenders are built
    // from the FULL set, so the aggregate picture stays exact even when the per-turn log is capped.
    // `Math.min(Math.max(1, topN ?? 25), 100)` — clamp, and NaN cannot reach it (the option is a
    // parsed number or absent).
    let cap = top_n.unwrap_or(DEFAULT_EVENTS_TOPN).clamp(1.0, MAX_EVENTS_TOPN);
    let cap_n = cap as usize;
    let truncated = events.len() > cap_n;
    let shown: Vec<Value> =
        if truncated { events[events.len() - cap_n..].iter().map(CacheBreakEvent::to_value).collect() } else { events.iter().map(CacheBreakEvent::to_value).collect() };

    let mut m = serde_json::Map::new();
    m.insert("sessionId".into(), Value::String(sid.to_owned()));
    if let Some(a) = account_uuid {
        m.insert("accountUuid".into(), Value::String(a));
    }
    if let Some(mo) = model {
        m.insert("model".into(), Value::String(mo));
    }
    m.insert("minTokens".into(), num(min_tokens));
    m.insert("systematicThreshold".into(), num(SYSTEMATIC_THRESHOLD));
    m.insert("turnsInSession".into(), num(turns.len() as f64));
    m.insert("turnsClassified".into(), num(events.len() as f64));
    m.insert("totalCacheCreateTokens".into(), num(events.iter().map(|e| e.cache_create_tokens).sum()));
    let shown_len = shown.len();
    m.insert("events".into(), Value::Array(shown));
    if truncated {
        m.insert(
            "eventsNote".into(),
            Value::String(format!(
                "Showing the most recent {shown_len} of {} classified break events (raise topN to see more, max {}). repeatOffenders/causeHistogram below already summarize ALL {}.",
                events.len(),
                fmt_js_num(MAX_EVENTS_TOPN),
                events.len()
            )),
        );
    }
    m.insert("causeHistogram".into(), build_histogram(&events));
    m.insert("repeatOffenders".into(), build_repeat_offenders(&events, session_cc));
    m.insert("coverage".into(), coverage);
    Value::Object(m)
}

/// Resolve the target session: exact sessionId > scope-prefix heaviest > overall heaviest by
/// cache_creation. Returns the session id and its turns ordered by mtime ASCENDING.
fn resolve_target<'a>(
    by_session: &'a IndexMap<String, Vec<ScannedTurn>>,
    resp_by_id: &HashMap<String, ResponseUsage>,
    opts: &CacheBreakTimelineOptions,
) -> Option<(String, Vec<&'a ScannedTurn>)> {
    let sorted = |turns: &'a [ScannedTurn]| -> Vec<&'a ScannedTurn> {
        let mut v: Vec<&ScannedTurn> = turns.iter().collect();
        v.sort_by(|a, b| a.mtime_ms.partial_cmp(&b.mtime_ms).expect("mtimes are never NaN"));
        v
    };
    if let Some(sid) = &opts.session_id {
        return by_session.get(sid).map(|t| (sid.clone(), sorted(t)));
    }
    let mut best: Option<(String, Vec<&ScannedTurn>, f64)> = None;
    for (sid, turns) in by_session {
        if sid == "(no-session)" {
            continue;
        }
        if let Some(scope) = &opts.scope {
            if !sid.starts_with(scope) {
                continue;
            }
        }
        let refs: Vec<&ScannedTurn> = turns.iter().collect();
        let cc = session_cache_create(&refs, resp_by_id);
        // STRICTLY greater, so the FIRST session at the maximum wins — IndexMap keeps the scan's
        // insertion order, which is what makes that deterministic.
        if best.as_ref().is_none_or(|b| cc > b.2) {
            best = Some((sid.clone(), sorted(turns), cc));
        }
    }
    best.map(|(sid, turns, _)| (sid, turns))
}

/// Build a session's cache-break ROOT-CAUSE timeline + repeat-offender rollup. Reconstructs the
/// session's ordered turns from the raw OTEL bodies, classifies each significant cache_creation
/// turn's break, and rolls repeated (cause, culprit-element) pairs into chronic offenders (flagged
/// SYSTEMATIC at ≥ threshold turns). `agent-<agentId>` child sessions resolve via their subagents
/// transcript. LAZY + BOUNDED: one recency-first capped scan; honest coverage.
pub fn build_cache_break_timeline(opts: &CacheBreakTimelineOptions) -> Value {
    let bodies_dir = opts.bodies_dir.clone().unwrap_or_else(|| crate::burn::guard::default_bodies_dir(&opts.data_dir));
    let min_tokens = opts.min_tokens.unwrap_or(DEFAULT_MIN_TOKENS);
    let scan_cap = opts.scan_cap.unwrap_or(RESPONSE_SCAN_CAP);
    let dir_exists = bodies_dir.exists();
    let store_dir = opts.store_dir.clone().unwrap_or_else(|| opts.data_dir.join("store"));
    // The raw dir alone no longer decides whether evidence exists — drained history lives in the
    // Parquet store, and a missing spool with a populated store is a NORMAL state, not "no data".
    if !dir_exists && !store_dir.join("bodies").exists() {
        let note = format!(
            "No raw-body evidence: neither {} nor the Parquet store at {} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.",
            bodies_dir.display(),
            store_dir.display()
        );
        return base_report(
            min_tokens,
            coverage_value(&bodies_dir, dir_exists, 0, 0, 0, 0, 0, scan_cap, opts.window_hours, true, note),
        );
    }

    let scan = scan_sessions_and_responses(&bodies_dir, &store_dir, opts.window_hours, scan_cap);
    let hook_dir = opts.hook_events_dir.clone().unwrap_or_else(|| opts.data_dir.join("hook-events"));
    let hook_info = load_compaction_hook_info(&hook_dir);

    if let Some((sid, turns)) = resolve_target(&scan.by_session, &scan.resp_by_id, opts) {
        let info = hook_info.get(&sid);
        return build_report_for_session(&sid, &turns, &scan.resp_by_id, min_tokens, scan.coverage, opts.top_n, info);
    }
    if let Some(sid) = &opts.session_id {
        // Not a metadata session id — try the sub-agent child path before giving up.
        let default_dirs;
        let projects_dirs: &[PathBuf] = match &opts.projects_dirs {
            Some(d) => d,
            None => {
                default_dirs = agentlens_logscan::discovery::claude_projects_dirs(&agentlens_logscan::discovery::Env::from_process());
                &default_dirs
            }
        };
        if let Some(sub) = resolve_subagent_stream(sid, &scan.by_session, projects_dirs) {
            if let Some(parent_turns) = scan.by_session.get(&sub.parent_session_id) {
                let picked: Vec<&ScannedTurn> = sub.turns.iter().map(|i| &parent_turns[*i]).collect();
                let mut cov = scan.coverage.clone();
                if let Some(note) = cov.get("note").and_then(Value::as_str) {
                    let merged = format!("{note} {}", sub.note);
                    cov["note"] = Value::String(merged);
                }
                return build_report_for_session(sid, &picked, &scan.resp_by_id, min_tokens, cov, opts.top_n, hook_info.get(sid));
            }
        }
        if sid.starts_with("agent-") {
            let mut cov = scan.coverage.clone();
            if let Some(note) = cov.get("note").and_then(Value::as_str) {
                let merged = format!(
                    "{note} '{sid}' looks like a sub-agent child id, but no subagents transcript (or no scanned parent turn) matched it — child timelines resolve via <projects>/<mangled>/<parentSessionId>/subagents/{sid}.jsonl plus the parent's raw bodies."
                );
                cov["note"] = Value::String(merged);
            }
            return base_report(min_tokens, cov);
        }
    }
    base_report(min_tokens, scan.coverage)
}

// ── buildCauseCostPeakReport — the 'cause' dimension of the cost-peak finder ──────
// TRDD-6TQ2FBUR D2: get_cache_creation_report generalizes into a COST-PEAK finder with
// groupBy {session|account|model|cause}. The first three stay in cache_creation_forensics (a
// lightweight response-only scan); `cause` needs the full prefix-diff classifier this module owns,
// so it lives here as a SEPARATE builder returning the identical report shape — the MCP tool
// dispatches on groupBy and formats either result with the SAME formatter, so callers see one
// uniform contract regardless of which builder ran.
pub struct CauseCostPeakOptions {
    pub data_dir: PathBuf,
    pub bodies_dir: Option<PathBuf>,
    pub store_dir: Option<PathBuf>,
    pub window_hours: Option<f64>,
    pub scan_cap: Option<usize>,
    /// Floor: only classify turns whose cache_creation >= this.
    pub min_tokens: Option<f64>,
    pub bucket: Option<String>,
    pub top_n: Option<f64>,
    pub hook_events_dir: Option<PathBuf>,
}

impl CauseCostPeakOptions {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            bodies_dir: None,
            store_dir: None,
            window_hours: None,
            scan_cap: None,
            min_tokens: None,
            bucket: None,
            top_n: None,
            hook_events_dir: None,
        }
    }
}

// The EMPTY report and the populated one carry DIFFERENT unattributed notes — the empty one stops
// at the first clause. Collapsing them into one constant is the obvious tidy-up and it is wrong on
// the wire; the fixture's no_evidence case is what caught it.
const CAUSE_UNATTRIBUTED_NOTE_EMPTY: &str =
    "groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session.";
const CAUSE_UNATTRIBUTED_NOTE: &str = "groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session (an un-joinable response is simply not part of any session's turn sequence, so it is never classified).";
const CAUSE_OUTPUT_SPIKE_NOTE: &str = "The biggest single OUTPUT-token break events (output is billed ~5x the input rate — sometimes the real cost peak, not the cache write). Rank by bucket=output or bucket=billable_weighted to surface these in the groups.";

/// The cost-peak finder's coverage shape: the SAME numbers as the timeline scan's coverage under
/// different field names (`requestFilesScanned` → `requestFilesIndexed`), so
/// get_cache_creation_report's contract is identical whichever builder produced the report.
fn cost_peak_coverage(timeline_coverage: &Value) -> Value {
    let g = |k: &str| timeline_coverage.get(k).cloned().unwrap_or(Value::Null);
    let mut m = serde_json::Map::new();
    m.insert("bodiesDir".into(), g("bodiesDir"));
    m.insert("dirExists".into(), g("dirExists"));
    m.insert("responseFilesTotal".into(), g("responseFilesTotal"));
    m.insert("responseFilesScanned".into(), g("responseFilesScanned"));
    m.insert("requestFilesTotal".into(), g("requestFilesTotal"));
    m.insert("requestFilesIndexed".into(), g("requestFilesScanned"));
    m.insert("scanCap".into(), g("scanCap"));
    if let Some(w) = timeline_coverage.get("windowHours") {
        m.insert("windowHours".into(), w.clone());
    }
    m.insert("complete".into(), g("complete"));
    m.insert("note".into(), g("note"));
    Value::Object(m)
}

fn empty_cause_cost_peak_report(bucket: &str, bodies_dir: &Path, scan_cap: usize, window_hours: Option<f64>) -> Value {
    let mut cov = serde_json::Map::new();
    cov.insert("bodiesDir".into(), Value::String(bodies_dir.to_string_lossy().into_owned()));
    cov.insert("dirExists".into(), Value::Bool(false));
    cov.insert("responseFilesTotal".into(), num(0.0));
    cov.insert("responseFilesScanned".into(), num(0.0));
    cov.insert("requestFilesTotal".into(), num(0.0));
    cov.insert("requestFilesIndexed".into(), num(0.0));
    cov.insert("scanCap".into(), num(scan_cap as f64));
    if let Some(w) = window_hours {
        cov.insert("windowHours".into(), num(w));
    }
    cov.insert("complete".into(), Value::Bool(true));
    cov.insert(
        "note".into(),
        Value::String(format!(
            "No OTEL raw-body directory at {} — set OTEL_LOG_RAW_API_BODIES to capture bodies.",
            bodies_dir.display()
        )),
    );
    let mut v = cause_report_value(bucket, window_hours, 0.0, 0.0, 0.0, 0.0, 0.0, Vec::new(), Vec::new(), Value::Object(cov));
    v["unattributed"]["note"] = Value::String(CAUSE_UNATTRIBUTED_NOTE_EMPTY.to_owned());
    // The empty report's outputSpikes note also stops early — no "Rank by bucket=..." tail.
    v["outputSpikes"]["note"] = Value::String(
        "The biggest single OUTPUT-token break events (output is billed ~5x — sometimes the real cost peak, not the cache write).".to_owned(),
    );
    v
}

#[allow(clippy::too_many_arguments)] // one wire object, two construction sites — the TS literal
fn cause_report_value(
    bucket: &str,
    window_hours: Option<f64>,
    total_cc: f64,
    total_cr: f64,
    total_in: f64,
    total_out: f64,
    total_cost: f64,
    groups: Vec<Value>,
    output_top: Vec<Value>,
    coverage: Value,
) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("bucket".into(), Value::String(bucket.to_owned()));
    out.insert("groupBy".into(), Value::String("cause".to_owned()));
    if let Some(w) = window_hours {
        out.insert("windowHours".into(), num(w));
    }
    out.insert("totalCacheCreateTokens".into(), num(total_cc));
    out.insert("totalCacheReadTokens".into(), num(total_cr));
    out.insert("totalInputTokens".into(), num(total_in));
    out.insert("totalOutputTokens".into(), num(total_out));
    out.insert("totalCostUsd".into(), num(js_to_fixed_num(total_cost, 4)));
    let mut un = serde_json::Map::new();
    un.insert("events".into(), num(0.0));
    un.insert("cacheCreateTokens".into(), num(0.0));
    un.insert("costUsd".into(), num(0.0));
    un.insert("note".into(), Value::String(CAUSE_UNATTRIBUTED_NOTE.to_owned()));
    out.insert("unattributed".into(), Value::Object(un));
    let mut sp = serde_json::Map::new();
    sp.insert("note".into(), Value::String(CAUSE_OUTPUT_SPIKE_NOTE.to_owned()));
    sp.insert("top".into(), Value::Array(output_top));
    out.insert("outputSpikes".into(), Value::Object(sp));
    out.insert("groups".into(), Value::Array(groups));
    out.insert("coverage".into(), coverage);
    Value::Object(out)
}

struct CauseGroup {
    cache_create: f64,
    cache_read: f64,
    input: f64,
    output: f64,
    total: f64,
    cost_usd: f64,
    events: f64,
    max_single_cc: f64,
    max_single_out: f64,
    bucket_value: f64,
}

/// The `cause` dimension of the cost-peak finder: scans EVERY session in the bounded window (not
/// just one target, unlike `build_cache_break_timeline`), classifies each session's significant
/// cache_creation turns via the SAME root-cause classifier the timeline uses, and ranks CAUSES by
/// the chosen cost bucket — answering "which BREAK CAUSE is burning the most money", not just
/// "which session". LAZY + BOUNDED: one shared scan; classification is O(turns already read).
pub fn build_cause_cost_peak_report(opts: &CauseCostPeakOptions) -> Value {
    let bodies_dir = opts.bodies_dir.clone().unwrap_or_else(|| crate::burn::guard::default_bodies_dir(&opts.data_dir));
    let min_tokens = opts.min_tokens.unwrap_or(DEFAULT_MIN_TOKENS);
    let scan_cap = opts.scan_cap.unwrap_or(RESPONSE_SCAN_CAP);
    let bucket = opts.bucket.clone().unwrap_or_else(|| "cache_creation".to_owned());
    let top_n = opts.top_n.unwrap_or(15.0).min(50.0);
    let store_dir = opts.store_dir.clone().unwrap_or_else(|| opts.data_dir.join("store"));
    if !bodies_dir.exists() && !store_dir.join("bodies").exists() {
        return empty_cause_cost_peak_report(&bucket, &bodies_dir, scan_cap, opts.window_hours);
    }

    let scan = scan_sessions_and_responses(&bodies_dir, &store_dir, opts.window_hours, scan_cap);
    let coverage = cost_peak_coverage(&scan.coverage);
    let hook_dir = opts.hook_events_dir.clone().unwrap_or_else(|| opts.data_dir.join("hook-events"));
    let hook_info = load_compaction_hook_info(&hook_dir);
    let now = now_ms();

    let mut groups: IndexMap<TimelineCause, CauseGroup> = IndexMap::new();
    let (mut total_cc, mut total_cr, mut total_in, mut total_out, mut total_cost) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut output_events: Vec<(f64, Value)> = Vec::new();

    for (sid, turns_raw) in &scan.by_session {
        if sid == "(no-session)" {
            continue;
        }
        let mut turns: Vec<&ScannedTurn> = turns_raw.iter().collect();
        turns.sort_by(|a, b| a.mtime_ms.partial_cmp(&b.mtime_ms).expect("mtimes are never NaN"));
        let account_uuid = turns.iter().find_map(|t| t.account_uuid.clone());
        let mut events = classify_turns(&turns, &scan.resp_by_id, min_tokens);
        apply_compaction_hook_evidence(&mut events, hook_info.get(sid));
        for e in &events {
            let t = crate::cache_creation_forensics::TokenCounts {
                input_tokens: e.input_tokens,
                cache_read_tokens: e.cache_read_tokens,
                cache_create_tokens: e.cache_create_tokens,
                output_tokens: e.output_tokens,
                model: e.model.as_deref(),
            };
            let full_cost = crate::cache_creation_forensics::token_counts_full_cost(&t, now);
            total_cc += e.cache_create_tokens;
            total_cr += e.cache_read_tokens;
            total_in += e.input_tokens;
            total_out += e.output_tokens;
            total_cost += full_cost;

            let g = groups.entry(e.cause).or_insert(CauseGroup {
                cache_create: 0.0,
                cache_read: 0.0,
                input: 0.0,
                output: 0.0,
                total: 0.0,
                cost_usd: 0.0,
                events: 0.0,
                max_single_cc: 0.0,
                max_single_out: 0.0,
                bucket_value: 0.0,
            });
            g.cache_create += e.cache_create_tokens;
            g.cache_read += e.cache_read_tokens;
            g.input += e.input_tokens;
            g.output += e.output_tokens;
            g.total += crate::cache_creation_forensics::token_counts_total(&t);
            g.cost_usd += full_cost;
            g.events += 1.0;
            g.max_single_cc = g.max_single_cc.max(e.cache_create_tokens);
            g.max_single_out = g.max_single_out.max(e.output_tokens);
            g.bucket_value += crate::cache_creation_forensics::bucket_value_of(&t, &bucket, now);

            if e.output_tokens > 0.0 {
                let mut m = serde_json::Map::new();
                // The literal's key order, with every `undefined` field DROPPED.
                m.insert("sessionId".into(), Value::String(sid.clone()));
                if let Some(a) = &account_uuid {
                    m.insert("accountUuid".into(), Value::String(a.clone()));
                }
                if let Some(mo) = &e.model {
                    m.insert("model".into(), Value::String(mo.clone()));
                }
                m.insert("outputTokens".into(), num(e.output_tokens));
                m.insert("cacheCreateTokens".into(), num(e.cache_create_tokens));
                m.insert("ts".into(), Value::String(e.ts.clone()));
                output_events.push((e.output_tokens, Value::Object(m)));
            }
        }
    }

    let mut ranked: Vec<(TimelineCause, CauseGroup)> = groups.into_iter().collect();
    // Rounded BEFORE the sort in the TS (`.map(...).sort(...)`), so two groups whose raw bucket
    // values differ below the 4th decimal rank as equal and keep insertion order.
    for (_, g) in ranked.iter_mut() {
        g.cost_usd = js_to_fixed_num(g.cost_usd, 4);
        g.bucket_value = js_to_fixed_num(g.bucket_value, 4);
    }
    ranked.sort_by(|a, b| b.1.bucket_value.partial_cmp(&a.1.bucket_value).expect("bucket values are never NaN"));
    let end = ranked.len().min(top_n.max(0.0) as usize);
    let group_values: Vec<Value> = ranked[..end]
        .iter()
        .map(|(cause, g)| {
            json!({
                "key": cause.id(),
                "cacheCreateTokens": num(g.cache_create),
                "cacheReadTokens": num(g.cache_read),
                "inputTokens": num(g.input),
                "outputTokens": num(g.output),
                "totalTokens": num(g.total),
                "costUsd": num(g.cost_usd),
                "events": num(g.events),
                "maxSingleCacheCreateTokens": num(g.max_single_cc),
                "maxSingleOutputTokens": num(g.max_single_out),
                "bucketValue": num(g.bucket_value),
            })
        })
        .collect();

    output_events.sort_by(|a, b| b.0.partial_cmp(&a.0).expect("output tokens are never NaN"));
    output_events.truncate(5);
    let output_top: Vec<Value> = output_events.into_iter().map(|(_, v)| v).collect();

    cause_report_value(&bucket, opts.window_hours, total_cc, total_cr, total_in, total_out, total_cost, group_values, output_top, coverage)
}

// ── Cross-session cause + actor backtrace (get_cache_break_causes) ────────────────
// The user's two-step forensic question, answered across ALL sessions at once: (1) which BREAK
// CAUSE is the most common / most expensive — and then (2) backtrace each break to the actual
// PERPETRATOR (keyed on the enriched culpritId = the MCP server / hook / sub-agent model / harness
// ToolSearch that CAUSED the change). The transcript is only ever the victim; this names who keeps
// breaking it.
pub struct CacheBreakCausesOptions {
    pub data_dir: PathBuf,
    pub bodies_dir: Option<PathBuf>,
    pub store_dir: Option<PathBuf>,
    pub window_hours: Option<f64>,
    pub scan_cap: Option<usize>,
    pub min_tokens: Option<f64>,
    /// Optional session-id prefix filter.
    pub scope: Option<String>,
    /// Cap on the actorLeaderboard (default 20, max 100).
    pub top_n: Option<f64>,
    pub hook_events_dir: Option<PathBuf>,
}

impl CacheBreakCausesOptions {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            bodies_dir: None,
            store_dir: None,
            window_hours: None,
            scan_cap: None,
            min_tokens: None,
            scope: None,
            top_n: None,
            hook_events_dir: None,
        }
    }
}

/// Cross-session cause ranking + perpetrator backtrace.
pub fn build_cache_break_causes(opts: &CacheBreakCausesOptions) -> Value {
    let bodies_dir = opts.bodies_dir.clone().unwrap_or_else(|| crate::burn::guard::default_bodies_dir(&opts.data_dir));
    let min_tokens = opts.min_tokens.unwrap_or(DEFAULT_MIN_TOKENS);
    let scan_cap = opts.scan_cap.unwrap_or(RESPONSE_SCAN_CAP);
    let top_n = opts.top_n.unwrap_or(20.0).clamp(1.0, 100.0) as usize;
    let dir_exists = bodies_dir.exists();
    let store_dir = opts.store_dir.clone().unwrap_or_else(|| opts.data_dir.join("store"));
    let assemble = |min_tokens: f64, total_events: f64, total: f64, cause_ranking: Vec<Value>, actors: Vec<Value>, verdict: String, coverage: Value| {
        let mut m = serde_json::Map::new();
        m.insert("minTokens".into(), num(min_tokens));
        m.insert("totalClassifiedEvents".into(), num(total_events));
        m.insert("totalCacheCreateTokens".into(), num(total));
        m.insert("causeRanking".into(), Value::Array(cause_ranking));
        m.insert("actorLeaderboard".into(), Value::Array(actors));
        m.insert("verdict".into(), Value::String(verdict));
        m.insert("coverage".into(), coverage);
        Value::Object(m)
    };
    if !dir_exists && !store_dir.join("bodies").exists() {
        let note = format!(
            "No raw-body evidence: neither {} nor the Parquet store at {} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.",
            bodies_dir.display(),
            store_dir.display()
        );
        let cov = coverage_value(&bodies_dir, dir_exists, 0, 0, 0, 0, 0, scan_cap, opts.window_hours, true, note);
        return assemble(min_tokens, 0.0, 0.0, Vec::new(), Vec::new(), "no data".to_owned(), cov);
    }

    let scan = scan_sessions_and_responses(&bodies_dir, &store_dir, opts.window_hours, scan_cap);
    struct CauseAcc {
        events: f64,
        cc: f64,
        sessions: HashSet<String>,
    }
    struct ActorAcc {
        cause: TimelineCause,
        actor: String,
        occ: f64,
        cc: f64,
        cost: f64,
        sessions: HashSet<String>,
    }
    let mut cause_map: IndexMap<TimelineCause, CauseAcc> = IndexMap::new();
    let mut actor_map: IndexMap<String, ActorAcc> = IndexMap::new();
    let (mut total, mut total_events) = (0.0, 0.0);

    let hook_dir = opts.hook_events_dir.clone().unwrap_or_else(|| opts.data_dir.join("hook-events"));
    let hook_info = load_compaction_hook_info(&hook_dir);
    for (sid, turns_raw) in &scan.by_session {
        if sid == "(no-session)" {
            continue;
        }
        if let Some(scope) = &opts.scope {
            if !sid.starts_with(scope) {
                continue;
            }
        }
        let mut turns: Vec<&ScannedTurn> = turns_raw.iter().collect();
        turns.sort_by(|a, b| a.mtime_ms.partial_cmp(&b.mtime_ms).expect("mtimes are never NaN"));
        let mut events = classify_turns(&turns, &scan.resp_by_id, min_tokens);
        apply_compaction_hook_evidence(&mut events, hook_info.get(sid));
        for e in &events {
            total += e.cache_create_tokens;
            total_events += 1.0;
            let c = cause_map.entry(e.cause).or_insert(CauseAcc { events: 0.0, cc: 0.0, sessions: HashSet::new() });
            c.events += 1.0;
            c.cc += e.cache_create_tokens;
            c.sessions.insert(sid.clone());
            let a = actor_map.entry(e.culprit_id.clone()).or_insert(ActorAcc {
                cause: e.cause,
                actor: e.culprit.clone(),
                occ: 0.0,
                cc: 0.0,
                cost: 0.0,
                sessions: HashSet::new(),
            });
            a.occ += 1.0;
            a.cc += e.cache_create_tokens;
            a.cost += e.cost_usd;
            a.sessions.insert(sid.clone());
        }
    }

    let pct = |n: f64| if total > 0.0 { js_to_fixed_num(100.0 * n / total, 1) } else { 0.0 };
    let mut causes: Vec<(TimelineCause, CauseAcc)> = cause_map.into_iter().collect();
    causes.sort_by(|a, b| b.1.cc.partial_cmp(&a.1.cc).expect("token counts are never NaN"));
    let cause_ranking: Vec<Value> = causes
        .iter()
        .map(|(cause, v)| {
            json!({
                "cause": cause.id(),
                "expected": cause.is_expected(),
                "events": num(v.events),
                "sessionsAffected": num(v.sessions.len() as f64),
                "cacheCreateTokens": num(v.cc),
                "pct": num(pct(v.cc)),
                "remediation": cause.remediation(),
            })
        })
        .collect();

    let mut actors: Vec<(String, ActorAcc)> = actor_map.into_iter().collect();
    actors.sort_by(|a, b| b.1.cc.partial_cmp(&a.1.cc).expect("token counts are never NaN"));
    // TRUNCATE BEFORE the verdict: the verdict reads the leaderboard it ships, so capping after it
    // would name an avoidable perpetrator the caller cannot see in the list. Pinned by `topn1`.
    actors.truncate(top_n);
    let actor_leaderboard: Vec<Value> = actors
        .iter()
        .map(|(actor_id, v)| {
            json!({
                "actorId": actor_id,
                "cause": v.cause.id(),
                "expected": v.cause.is_expected(),
                "actor": v.actor,
                "occurrences": num(v.occ),
                "sessionsAffected": num(v.sessions.len() as f64),
                "totalCacheCreateTokens": num(v.cc),
                "totalCostUsd": num(js_to_fixed_num(v.cost, 4)),
                "pct": num(pct(v.cc)),
                "remediation": v.cause.remediation(),
            })
        })
        .collect();

    // The verdict names the top AVOIDABLE perpetrator — ranking by raw tokens alone crowns
    // COLD_START / NORMAL_GROWTH (expected behavior, unactionable) and buries the actual
    // misconfiguration.
    let top = actors.first();
    let top_avoidable = actors.iter().find(|(_, v)| !v.cause.is_expected());
    let verdict = match (top, top_avoidable) {
        (None, _) => "No significant cache_creation breaks classified in the scanned window.".to_owned(),
        (Some((_, t)), None) => format!(
            "All classified break cost is EXPECTED cache behavior (cold warms / compaction / incremental growth / interleave) — no avoidable perpetrator found. Largest: {} ({}) at {}%.",
            t.actor,
            t.cause.id(),
            fmt_js_num(pct(t.cc))
        ),
        (Some((top_id, t)), Some((av_id, a))) => {
            let overall_note = if av_id != top_id {
                format!(" (Largest overall is {} ({}) at {}%, but that cause is expected/unavoidable.)", t.actor, t.cause.id(), fmt_js_num(pct(t.cc)))
            } else {
                String::new()
            };
            format!(
                "Dominant AVOIDABLE perpetrator: {} ({}) — {} cache_creation tokens across {} session(s), {}% of all classified breaks. {}{overall_note}",
                a.actor,
                a.cause.id(),
                to_locale_en(a.cc),
                a.sessions.len(),
                fmt_js_num(pct(a.cc)),
                a.cause.remediation()
            )
        }
    };

    assemble(min_tokens, total_events, total, cause_ranking, actor_leaderboard, verdict, scan.coverage)
}

// ── Output formatting ────────────────────────────────────────────────────────────
/// Render a timeline report in the requested format. `json` → the object itself; the others → a
/// compact string wrapped as `{ format, text, sessionId, coverage }` so the MCP result stays
/// JSON-serializable.
pub fn format_timeline(report: &Value, format: &str) -> Value {
    if format == "json" {
        return report.clone();
    }
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let empty: Vec<Value> = Vec::new();
    let events = report.get("events").and_then(Value::as_array).unwrap_or(&empty);
    let offenders = report.get("repeatOffenders").and_then(Value::as_array).unwrap_or(&empty);
    let session_id = report.get("sessionId").and_then(Value::as_str);
    let model = report.get("model").and_then(Value::as_str);
    let hdr = format!(
        "cache-break timeline — session {}{}",
        session_id.unwrap_or("(none)"),
        model.map_or(String::new(), |m| format!(" [{m}]"))
    );
    let mut lines: Vec<String> = Vec::new();
    let gap_of = |e: &Value| e.get("gapMinutes").and_then(Value::as_f64);
    match format {
        "markdown" => {
            lines.push(format!("# {hdr}"));
            lines.push(String::new());
            lines.push(format!(
                "- turns: {}, classified breaks: {}, total cache_creation: {}",
                fmt_js_num(n(report, "turnsInSession")),
                fmt_js_num(n(report, "turnsClassified")),
                to_locale_en(n(report, "totalCacheCreateTokens"))
            ));
            lines.push(String::new());
            lines.push("## Repeat offenders (chronic first)".to_owned());
            lines.push(String::new());
            lines.push("| cause | culprit | turns | tokens | % | systematic |".to_owned());
            lines.push("|---|---|---|---|---|---|".to_owned());
            for o in offenders {
                lines.push(format!(
                    "| {} | {} | {} | {} | {}% | {} |",
                    s(o, "cause"),
                    s(o, "culprit"),
                    fmt_js_num(n(o, "occurrences")),
                    to_locale_en(n(o, "totalCacheCreateTokens")),
                    fmt_js_num(n(o, "pctOfSessionCacheCreate")),
                    if o.get("systematic").is_some_and(truthy) { "⚠️ YES" } else { "" }
                ));
            }
            lines.push(String::new());
            lines.push("## Timeline".to_owned());
            lines.push(String::new());
            for e in events {
                lines.push(format!(
                    "- turn {} `{}` **{}** — {} ({} tok{})",
                    fmt_js_num(n(e, "turn")),
                    s(e, "ts"),
                    s(e, "cause"),
                    s(e, "culprit"),
                    to_locale_en(n(e, "cacheCreateTokens")),
                    gap_of(e).map_or(String::new(), |g| format!(", +{}m", fmt_js_num(g)))
                ));
            }
        }
        "table" => {
            lines.push(hdr.clone());
            lines.push("turn  cause                       tokens      gap    culprit".to_owned());
            for e in events {
                lines.push(format!(
                    "{}  {} {}  {}  {}",
                    pad_start(&fmt_js_num(n(e, "turn")), 4),
                    pad_end(&s(e, "cause"), 26),
                    pad_start(&fmt_js_num(n(e, "cacheCreateTokens")), 9),
                    pad_start(&gap_of(e).map_or("-".to_owned(), |g| format!("{}m", fmt_js_num(g))), 6),
                    s(e, "culprit")
                ));
            }
            lines.push(String::new());
            lines.push("REPEAT OFFENDERS:".to_owned());
            for o in offenders {
                lines.push(format!(
                    "  {}{} ×{} ({} tok, {}%) — {}",
                    if o.get("systematic").is_some_and(truthy) { "⚠️ " } else { "  " },
                    s(o, "cause"),
                    fmt_js_num(n(o, "occurrences")),
                    fmt_js_num(n(o, "totalCacheCreateTokens")),
                    fmt_js_num(n(o, "pctOfSessionCacheCreate")),
                    s(o, "culprit")
                ));
            }
        }
        _ => {
            lines.push(hdr.clone());
            for e in events {
                let cause = s(e, "cause");
                let bar = if cause.starts_with("TOOL") {
                    "🔧"
                } else if cause == "MODEL_SWITCH" {
                    "🔀"
                } else if cause == "TTL_EXPIRY" {
                    "⏱️"
                } else if cause == "COLD_START" {
                    "❄️"
                } else if cause.contains("SKILL") {
                    "📎"
                } else if cause == "HOOK_INJECTION" {
                    "🪝"
                } else {
                    "⚠️"
                };
                lines.push(format!(
                    "{}  {bar} turn {}  {cause}  {} tok — {}",
                    s(e, "ts"),
                    fmt_js_num(n(e, "turn")),
                    to_locale_en(n(e, "cacheCreateTokens")),
                    s(e, "culprit")
                ));
            }
            if let Some(worst) = offenders.iter().find(|o| o.get("systematic").is_some_and(truthy)) {
                lines.push(String::new());
                lines.push(format!("VERDICT: {}", s(worst, "verdict")));
            }
        }
    }
    if let Some(note) = report.get("eventsNote").and_then(Value::as_str) {
        lines.push(String::new());
        lines.push(note.to_owned());
    }
    let mut m = serde_json::Map::new();
    m.insert("format".into(), Value::String(format.to_owned()));
    m.insert("text".into(), Value::String(lines.join("\n")));
    if let Some(sid) = session_id {
        m.insert("sessionId".into(), Value::String(sid.to_owned()));
    }
    m.insert("coverage".into(), report.get("coverage").cloned().unwrap_or(Value::Null));
    Value::Object(m)
}
