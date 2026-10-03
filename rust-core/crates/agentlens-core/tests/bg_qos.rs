//! TRDD-RVKQDLRD: `set_background_qos` really lowers the calling thread (and a background-runtime
//! task) to QOS_CLASS_BACKGROUND. Real syscalls, no mocks. macOS only: QoS classes do not exist
//! elsewhere and `set_background_qos` is a no-op there.
#![cfg(target_os = "macos")]

use agentlens_core::bg_qos::{current_qos_name, set_background_qos};

/// A plain thread that calls `set_background_qos` reports QOS_CLASS_BACKGROUND afterwards.
#[test]
fn a_thread_calling_set_background_qos_reports_background() {
    let class = std::thread::spawn(|| {
        set_background_qos();
        current_qos_name()
    })
    .join()
    .unwrap();
    assert_eq!(class, "background");
}

/// A task (and its blocking-pool task) on a runtime built like alcore's chores runtime runs on a
/// BACKGROUND thread.
#[test]
fn tasks_on_the_background_runtime_run_at_background_qos() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .thread_name("alcore-bg")
        .on_thread_start(set_background_qos)
        .enable_all()
        .build()
        .unwrap();
    let (worker, blocking) = rt.block_on(async {
        let w = tokio::spawn(async { current_qos_name() }).await.unwrap();
        let b = tokio::task::spawn_blocking(current_qos_name).await.unwrap();
        (w, b)
    });
    assert_eq!(worker, "background");
    assert_eq!(blocking, "background");
}
