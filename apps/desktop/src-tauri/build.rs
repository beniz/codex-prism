fn main() {
    println!("cargo:rerun-if-env-changed=PRISM_UPDATE_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=PRISM_OFFICIAL_BUILD");
    println!("cargo:rerun-if-env-changed=PRISM_MANUAL_RELEASE");
    let manual_release = std::env::var("PRISM_MANUAL_RELEASE").as_deref() == Ok("1");
    println!(
        "cargo:rustc-env=PRISM_UPDATE_PUBLIC_KEY={}",
        if manual_release {
            String::new()
        } else {
            std::env::var("PRISM_UPDATE_PUBLIC_KEY").unwrap_or_default()
        }
    );
    println!(
        "cargo:rustc-env=PRISM_OFFICIAL_BUILD={}",
        std::env::var("PRISM_OFFICIAL_BUILD").unwrap_or_default()
    );
    if std::env::var("PRISM_OFFICIAL_BUILD").as_deref() == Ok("1") && !manual_release {
        assert!(
            !std::env::var("PRISM_UPDATE_PUBLIC_KEY")
                .unwrap_or_default()
                .is_empty(),
            "Official builds require the updater public key"
        );
    }
    tauri_build::build()
}
