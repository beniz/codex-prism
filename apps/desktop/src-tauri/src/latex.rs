//! Desktop IPC adapters. Backend implementation lives in prism-core.

use prism_core::latex::*;

#[tauri::command]
pub fn detect_texlive(backend: tauri::State<'_, prism_core::Backend>) -> TexliveStatus {
    backend.detect_texlive()
}
