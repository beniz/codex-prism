fn main() {
    println!("cargo:rerun-if-env-changed=PRISM_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PRISM_OFFICIAL_BUILD");
    println!(
        "cargo:rustc-env=PRISM_UPDATE_PUBLIC_KEY={}",
        std::env::var("PRISM_UPDATE_PUBLIC_KEY").unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=PRISM_OFFICIAL_BUILD={}",
        std::env::var("PRISM_OFFICIAL_BUILD").unwrap_or_default()
    );
    if std::env::var("PRISM_OFFICIAL_BUILD").as_deref() == Ok("1") {
        assert!(
            !std::env::var("PRISM_UPDATE_PUBLIC_KEY")
                .unwrap_or_default()
                .is_empty(),
            "Official builds require the updater public key"
        );
    }
    tauri_build::build()
}
