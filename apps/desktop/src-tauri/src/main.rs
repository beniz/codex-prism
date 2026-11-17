// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::var("PRISM_GIT_ASKPASS").as_deref() == Ok("1") {
        let prompt = std::env::args()
            .nth(1)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if prompt.contains("username") {
            println!(
                "{}",
                std::env::var("PRISM_GIT_USER").unwrap_or_else(|_| "oauth2".into())
            );
        } else if let Ok(token) = std::env::var("PRISM_GIT_TOKEN") {
            println!("{token}");
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--prism-source-mcp") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build();
        match runtime {
            Ok(runtime) => {
                if let Err(error) = runtime.block_on(prism_core::source_mcp::run_stdio()) {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    codex_prism_desktop_lib::run()
}
