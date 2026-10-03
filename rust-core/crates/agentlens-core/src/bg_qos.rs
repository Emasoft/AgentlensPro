//! Background scheduling class for alcore's own work (TRDD-RVKQDLRD).
//!
//! WHY: alcore's chores, rayon scan and log sweeper used to share normal-priority threads with the
//! user's foreground apps, so a cold scan starved the machine. macOS QoS is per-thread
//! (`pthread_set_qos_class_self_np` sets the CURRENT thread only), so every background thread
//! must call this itself from its start hook; nothing is inherited reliably.

/// Lower the calling thread to QOS_CLASS_BACKGROUND. No-op on other OSes. A non-zero return is
/// reported once on stderr with the errno value and NOT swallowed silently — the server keeps
/// running, but the operator sees that background work is still at normal priority.
pub fn set_background_qos() {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain FFI call with a by-value enum and a relative priority of 0; it only
        // affects the calling thread.
        let rc = unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0) };
        if rc != 0 {
            eprintln!("{} alcore: pthread_set_qos_class_self_np(BACKGROUND) failed: errno {rc}", crate::log_ts());
        }
    }
}

/// Name of the calling thread's current QoS class, read back from the OS (`"n/a"` off macOS).
/// WHY (TRDD-RVKQDLRD): lets the production wiring prove itself at startup and in tests, instead
/// of trusting that a start hook ran on every thread.
pub fn current_qos_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        use libc::qos_class_t as Q;
        let mut class = Q::QOS_CLASS_UNSPECIFIED;
        let mut prio: libc::c_int = 0;
        // SAFETY: out-pointers are valid locals; queries the calling thread only.
        let rc = unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut prio) };
        if rc != 0 {
            return "query-failed";
        }
        match class {
            Q::QOS_CLASS_USER_INTERACTIVE => "user-interactive",
            Q::QOS_CLASS_USER_INITIATED => "user-initiated",
            Q::QOS_CLASS_DEFAULT => "default",
            Q::QOS_CLASS_UTILITY => "utility",
            Q::QOS_CLASS_BACKGROUND => "background",
            Q::QOS_CLASS_UNSPECIFIED => "unspecified",
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "n/a"
    }
}
