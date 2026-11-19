//! Desktop IPC adapters. Backend implementation lives in prism-core.

#[tauri::command]
pub async fn collaboration(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: Option<String>,
    operation: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    backend.collaboration(project_id, operation, args).await
}

#[tauri::command]
pub async fn project_service(
    backend: tauri::State<'_, prism_core::Backend>,
    project_id: String,
    operation: String,
    args: serde_json::Value,
    binary_pdf: Option<bool>,
) -> Result<tauri::ipc::InvokeResponseBody, String> {
    use tauri::ipc::IpcResponse;
    if binary_pdf == Some(true) {
        let Some(pdf) = backend.project_pdf(project_id, operation, args).await? else {
            return serde_json::Value::Null.body().map_err(|e| e.to_string());
        };
        if pdf.metadata.is_null() {
            return Ok(pdf.bytes.into());
        }
        // Proposal replies include a length-prefixed JSON header for SyncTeX and
        // ownership, followed by the raw PDF. Main PDFs need no header.
        let header = serde_json::to_vec(&pdf.metadata).map_err(|e| e.to_string())?;
        let length = u32::try_from(header.len()).map_err(|_| "PDF metadata too large")?;
        let mut response = Vec::with_capacity(4 + header.len() + pdf.bytes.len());
        response.extend_from_slice(&length.to_le_bytes());
        response.extend_from_slice(&header);
        response.extend_from_slice(&pdf.bytes);
        return Ok(response.into());
    }
    backend
        .project_service(project_id, operation, args)
        .await?
        .body()
        .map_err(|e| e.to_string())
}
