// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Resolve the directory where the persistent mappings file lives.
///
/// Priority:
///   1. `{CARGO_MANIFEST_DIR}/../data` — the project's `data/` folder next to
///      `src-tauri/`. This keeps the file inside the repo so it can be
///      committed to git and shared across team members.
///   2. AppLocalData fallback — used when the project folder is not writable
///      (e.g. a packaged production build installed on another machine).
fn persistent_mappings_dir(app: &tauri::AppHandle) -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Project root = parent of src-tauri/. At compile time this is the repo
    // checkout on the machine that built the binary, which is what we want
    // for the git-shared workflow.
    let project_root = manifest_dir.join("..");
    let project_data_dir = project_root.join("data");

    if project_root.exists() {
        // We're running from the repo checkout — write into the repo's data/
        // folder (created on demand) so the file can be committed to git.
        project_data_dir
    } else {
        // Packaged build on another machine — fall back to local app data.
        app.path()
            .app_local_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
    }
}

/// Read the persistent mappings JSON file as a raw string.
/// Returns Ok(None) when the file does not exist yet.
#[tauri::command]
fn read_persistent_mappings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = persistent_mappings_dir(&app);
    let file = dir.join("persistent-mappings.json");
    if !file.exists() {
        return Ok(None);
    }

    fs::read_to_string(&file)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Write the persistent mappings JSON file (creating the directory if needed).
#[tauri::command]
fn write_persistent_mappings(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let dir = persistent_mappings_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("persistent-mappings.json");
    fs::write(&file, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_persistent_mappings,
            write_persistent_mappings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
