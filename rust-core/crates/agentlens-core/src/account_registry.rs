//! src/rawBodyContext.ts CallBodyRegistry — the ACCOUNT half (TRDD-BURNWDGT): session_id →
//! account_uuid, harvested at OTLP ingest from the body-pointer log events' `user.account_uuid`
//! (the standalone server's inline log processor, server.ts processLogs), so a log card can carry
//! `accountId` without re-reading a multi-MB body. An IDENTIFIER, never a token. Bounded: the
//! same maxSessions cap (200), MRU re-insert, oldest evicted first. `account_for` is fail-soft —
//! unknown is unknown, never fabricated. The body-POINTER half (`record`/`resolveRequest`) backs
//! the call-context drill, a later slice (TRDD-DMWOBWFH P5c).

use indexmap::IndexMap;

pub const MAX_SESSIONS: usize = 200;

#[derive(Default)]
pub struct AccountRegistry {
    session_accounts: IndexMap<String, String>,
}

impl AccountRegistry {
    /// recordAccount — ignores empty ids; re-inserts so eviction stays MRU-ish.
    pub fn record(&mut self, session_id: &str, account_uuid: &str) {
        if session_id.is_empty() || account_uuid.is_empty() {
            return;
        }
        self.session_accounts.shift_remove(session_id);
        self.session_accounts.insert(session_id.to_owned(), account_uuid.to_owned());
        while self.session_accounts.len() > MAX_SESSIONS {
            self.session_accounts.shift_remove_index(0);
        }
    }

    /// accountFor — the account_uuid recorded for a session, or None when unknown.
    /// The whole session→account map, for a caller that must resolve accounts OUTSIDE the state
    /// lock (TRDD-465EXTJ6). `summary_over` is a free function by design (TRDD-HFV4AIT7) and so
    /// cannot borrow the registry; it carries this snapshot in `SummaryInputs` instead. The map is
    /// capped at `MAX_SESSIONS` (200), so cloning it is bounded and small.
    pub fn snapshot(&self) -> IndexMap<String, String> {
        self.session_accounts.clone()
    }

    pub fn account_for(&self, session_id: &str) -> Option<&str> {
        self.session_accounts.get(session_id).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.session_accounts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.session_accounts.is_empty()
    }
}
