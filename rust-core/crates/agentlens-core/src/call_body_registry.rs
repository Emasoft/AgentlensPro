//! The raw-body POINTER index (TRDD-DMWOBWFH P4w.1) — ports `CallBodyRegistry` from
//! src/rawBodyContext.ts:46–155, the spine every per-session drill-down route (freeze rows
//! 32–37) resolves through.
//!
//! POINTER-ONLY, and that is the whole design: the OTLP logs ingest feeds this a file path +
//! ids per call, NEVER the multi-MB body. A call is resolved to its body file on demand.
//!
//! ACCOUNT HALF NOT PORTED HERE, deliberately: the TS class also carries
//! `sessionAccounts`/`recordAccount`/`accountFor`, but the Rust core already has that as
//! `account_registry::AccountRegistry` (CoreState.accounts), wired since the P3b logs ingest.
//! Porting it a second time would be two sources of truth for one fact.

use indexmap::IndexMap;

/// CallBodyPointer — one raw request/response body's address. Mirrors agentlens_ingest's
/// `BodyPointer` (the ingest emits exactly this, minus the registry).
#[derive(Clone, Debug)]
pub struct CallBodyPointer {
    pub kind: &'static str, // "request" | "response"
    pub body_ref: Option<String>,
    pub inline_body: Option<String>,
    pub request_id: Option<String>,
    pub span_id: Option<String>,
    pub model: Option<String>,
    pub query_source: Option<String>,
    /// Arrival epoch-ms — the nearest-preceding correlation key.
    pub ts: i64,
}

/// Bounded (LRU by session, capped per session) index. One instance per process, fed by every
/// ingest path so there is ONE source of truth regardless of runtime.
pub struct CallBodyRegistry {
    /// IndexMap because the TS relies on JS Map INSERTION ORDER for MRU: `record` re-inserts a
    /// touched session so the oldest key is always the eviction candidate, and `session_ids`
    /// reverses it to answer most-recent-first.
    map: IndexMap<String, Vec<CallBodyPointer>>,
    max_sessions: usize,
    max_per_session: usize,
}

impl Default for CallBodyRegistry {
    fn default() -> Self {
        CallBodyRegistry::new(200, 400)
    }
}

impl CallBodyRegistry {
    pub fn new(max_sessions: usize, max_per_session: usize) -> CallBodyRegistry {
        CallBodyRegistry { map: IndexMap::new(), max_sessions, max_per_session }
    }

    /// record — a pointer with neither a bodyRef nor an inline body addresses nothing and is
    /// dropped, as is an empty session id. Touching a session moves it to the MRU end
    /// (shift_remove, not swap_remove: swap would destroy the insertion order the whole LRU
    /// depends on). Per-session overflow drops the OLDEST pointers; map overflow evicts the
    /// oldest SESSION.
    pub fn record(&mut self, session_id: &str, ptr: CallBodyPointer) {
        if session_id.is_empty() || (ptr.body_ref.is_none() && ptr.inline_body.is_none()) {
            return;
        }
        let mut list = self.map.shift_remove(session_id).unwrap_or_default();
        list.push(ptr);
        if list.len() > self.max_per_session {
            list.drain(..list.len() - self.max_per_session);
        }
        self.map.insert(session_id.to_owned(), list);
        while self.map.len() > self.max_sessions {
            self.map.shift_remove_index(0);
        }
    }

    /// The ingest's own emitted shape, straight in — one conversion site so the field mapping
    /// cannot drift between the two structs.
    pub fn record_ingested(&mut self, p: agentlens_ingest::BodyPointer) {
        let session = p.session_id.clone();
        self.record(
            &session,
            CallBodyPointer {
                kind: p.kind,
                body_ref: p.body_ref,
                inline_body: p.inline_body,
                request_id: p.request_id,
                span_id: p.span_id,
                model: p.model,
                query_source: p.query_source,
                ts: p.ts,
            },
        );
    }

    /// resolveRequest — the REQUEST pointer for one call. The request-body event carries
    /// spanId + body_ref but NOT request_id (the API assigns it); the response-body event
    /// carries request_id. So a caller who only knows request_id hops response→request via the
    /// shared spanId, else nearest-PRECEDING request by ts. Then spanId. Then the session's
    /// latest request.
    pub fn resolve_request(&self, session_id: &str, request_id: Option<&str>, span_id: Option<&str>) -> Option<&CallBodyPointer> {
        let list = self.map.get(session_id)?;
        if list.is_empty() {
            return None;
        }
        let requests: Vec<&CallBodyPointer> = list.iter().filter(|p| p.kind == "request").collect();
        if requests.is_empty() {
            return None;
        }
        if let Some(rid) = request_id {
            if let Some(direct) = requests.iter().find(|p| p.request_id.as_deref() == Some(rid)) {
                return Some(direct);
            }
            if let Some(resp) = list.iter().find(|p| p.kind == "response" && p.request_id.as_deref() == Some(rid)) {
                if let Some(rsid) = resp.span_id.as_deref() {
                    if let Some(paired) = requests.iter().find(|p| p.span_id.as_deref() == Some(rsid)) {
                        return Some(paired);
                    }
                }
                // `.filter(ts <= resp.ts).sort((a,b) => b.ts - a.ts)[0]` — the newest request at
                // or before the response. max_by_key takes the LAST maximum on ties, which is
                // what a stable descending sort's [0] also yields for equal ts.
                if let Some(preceding) = requests.iter().filter(|p| p.ts <= resp.ts).max_by_key(|p| p.ts) {
                    return Some(preceding);
                }
            }
        }
        if let Some(sid) = span_id {
            if let Some(by_span) = requests.iter().find(|p| p.span_id.as_deref() == Some(sid)) {
                return Some(by_span);
            }
        }
        requests.last().copied()
    }

    /// sessionIds — most-recently-used FIRST (record re-inserts, so insertion order is LRU→MRU
    /// and the reverse is MRU→LRU). The composition index enumerates a bounded slice of these
    /// for a broad-scope query — the LAZY contract, never a full-disk sweep of the 20k+ bodies.
    pub fn session_ids(&self) -> Vec<&str> {
        self.map.keys().rev().map(String::as_str).collect()
    }

    /// requestPointers — one session's request pointers, oldest→newest. The index maps these to
    /// 1-based turns (each request body IS one llm call), so the ORDER is a wire contract:
    /// `sort_by_key` is stable, matching V8's stable sort on equal ts.
    pub fn request_pointers(&self, session_id: &str) -> Vec<&CallBodyPointer> {
        let Some(list) = self.map.get(session_id) else { return Vec::new() };
        let mut out: Vec<&CallBodyPointer> = list.iter().filter(|p| p.kind == "request").collect();
        out.sort_by_key(|p| p.ts);
        out
    }

    /// responseFor — the RESPONSE paired with a request, joined on the shared spanId (the
    /// request-body event lacks the API-assigned request_id). Falls back to requestId. This is
    /// what makes the composition index's EXACT per-call usage readable instead of estimated.
    pub fn response_for(&self, session_id: &str, span_id: Option<&str>, request_id: Option<&str>) -> Option<&CallBodyPointer> {
        let list = self.map.get(session_id)?;
        let responses = || list.iter().filter(|p| p.kind == "response");
        if let Some(sid) = span_id {
            if let Some(by_span) = responses().find(|p| p.span_id.as_deref() == Some(sid)) {
                return Some(by_span);
            }
        }
        if let Some(rid) = request_id {
            if let Some(by_req) = responses().find(|p| p.request_id.as_deref() == Some(rid)) {
                return Some(by_req);
            }
        }
        None
    }

    /// Sessions currently held — the bound `/api/server-stats` style callers can report.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
