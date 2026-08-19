//! Port of src/shared/tokenBuckets.ts — THE constructor of the four-disjoint-buckets invariant
//! (TRDD-DMWOBWFH P4d). 'openai'-shaped usage sheds cacheRead from input at construction
//! (cached ⊂ input upstream); 'anthropic'-shaped passes through. inputTokens NEVER contains a
//! cache token — the 2026-07-10 double-billing incident is why this lives in one place.

use super::helpers::TokenCounts;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum UsageShape {
    Anthropic,
    OpenAi,
}

#[derive(Clone, Copy, Default)]
pub struct TokenBuckets {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
}

fn clamp(n: f64) -> f64 {
    if n.is_finite() && n > 0.0 { n } else { 0.0 }
}

pub fn disjoint_buckets(usage: &TokenCounts, shape: UsageShape) -> TokenBuckets {
    let input = clamp(usage.input);
    let cache_read = clamp(usage.cache_read);
    TokenBuckets {
        input_tokens: if shape == UsageShape::OpenAi { (input - cache_read).max(0.0) } else { input },
        output_tokens: clamp(usage.output),
        cache_read_tokens: cache_read,
        cache_create_tokens: clamp(usage.cache_create),
    }
}

/// Context-window occupancy: raw input + cache re-reads + cache writes.
pub fn context_tokens(b: &TokenBuckets) -> f64 {
    b.input_tokens + b.cache_read_tokens + b.cache_create_tokens
}
