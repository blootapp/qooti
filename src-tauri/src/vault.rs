use std::path::{Path, PathBuf};
use tauri::Manager;

pub struct VaultPaths {
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub media_dir: PathBuf,
    pub thumbs_dir: PathBuf,
}

/// Electron stored vault at %APPDATA%/qooti/vault. Tauri uses com.qooti.desktop/vault.
/// Prefer legacy path when it exists (has DB or content) so we use migrated data.
fn legacy_electron_vault_root(app_data: &Path) -> PathBuf {
    let parent = app_data.parent().unwrap_or(app_data);
    parent.join("qooti").join("vault")
}

fn vault_paths_from_root(root: PathBuf) -> VaultPaths {
    VaultPaths {
        db_path: root.join("qooti.db"),
        media_dir: root.join("media"),
        thumbs_dir: root.join("thumbnails"),
        root,
    }
}

pub fn get_vault_paths(
    app_handle: &tauri::AppHandle,
) -> Result<VaultPaths, Box<dyn std::error::Error>> {
    let app_data = app_handle.path().app_data_dir().expect("app data dir");
    let default_root = app_data.join("vault");
    let legacy_root = legacy_electron_vault_root(&app_data);

    // Use Electron legacy path if it exists and has data
    let root = if legacy_root != default_root && legacy_root.join("qooti.db").exists() {
        legacy_root
    } else {
        default_root
    };

    Ok(vault_paths_from_root(root))
}

pub fn ensure_vault(paths: &VaultPaths) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&paths.root)?;
    std::fs::create_dir_all(&paths.media_dir)?;
    std::fs::create_dir_all(&paths.thumbs_dir)?;
    Ok(())
}

pub fn write_vault_readme(vault_dir: &Path) {
    let path = vault_dir.join("README.txt");
    if path.exists() {
        return;
    }
    let _ = std::fs::write(
        &path,
        "This folder contains internal data for Qooti.\n\
Files here are managed exclusively by the application.\n\
Modifying or deleting files may cause permanent data loss.\n\
Files cannot be opened directly outside of Qooti.\n",
    );
}
