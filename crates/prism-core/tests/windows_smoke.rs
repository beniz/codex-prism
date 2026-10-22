#![cfg(target_os = "windows")]

/// Real installed CLI check; no inference requests and no credential output.
#[tokio::test]
#[ignore = "requires installed Codex CLI and network access for its model catalogue"]
async fn windows_installed_codex_initializes_and_lists_models() {
    let temp = tempfile::tempdir().unwrap();
    let backend = prism_core::Backend::new(
        prism_core::BackendConfig {
            data_dir: temp.path().join("data"),
            home_dir: temp.path().join("home"),
            temp_dir: temp.path().join("tmp"),
        },
        std::sync::Arc::new(prism_core::NoopEventSink),
    )
    .unwrap();
    let status = backend.codex_status().await.unwrap();
    assert!(status["binary"].as_str().unwrap().ends_with(".exe"));
    assert!(status["version"].as_str().unwrap().contains("codex"));
    assert!(!status["models"]["data"].as_array().unwrap().is_empty());
    backend.shutdown().await;
}
