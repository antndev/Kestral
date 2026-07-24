mod approval;
mod audit;
mod commands;
mod error;
mod hosts;
mod mcp;
mod model;
mod policy;
mod sftp;
mod skill;
mod snippets;
mod ssh;
mod state;
mod terminal;
mod util;
mod vault;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::state::{AppState, McpInfo, Services};

const MCP_PORT: u16 = 4517;

fn kestral_data_dir() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(dir) = std::env::var_os("KESTRAL_DATA_DIR")
        .or_else(|| std::env::var_os("HELMSMAN_DATA_DIR"))
    {
        return PathBuf::from(dir);
    }
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return PathBuf::from(".");
    };
    let home = PathBuf::from(home);
    let dir = home.join(".kestral");
    let old = home.join(".helmsman");

    if !dir.exists() && old.exists() {
        match std::fs::rename(&old, &dir) {
            Ok(()) => tracing::info!(
                "Datenordner von {} nach {} migriert",
                old.display(),
                dir.display()
            ),
            Err(e) => {
                tracing::error!(
                    "Datenordner {} konnte nicht nach {} umbenannt werden: {e}. \
                     Nutze weiterhin den alten Ordner.",
                    old.display(),
                    dir.display()
                );
                return old;
            }
        }
    }
    dir
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().try_init().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let base_dir = kestral_data_dir();
            let _ = std::fs::create_dir_all(&base_dir);
            util::restrict_dir(&base_dir);
            let vault_path = base_dir.join("vault.json");

            let vault = Arc::new(vault::Vault::new(vault_path));
            let services = Services {
                vault: vault.clone(),
                hosts: Arc::new(hosts::HostStore::new(base_dir.join("hosts.json"), vault.clone())),
                policy: Arc::new(policy::PolicyEngine::new()),
                approval: Arc::new(approval::ApprovalBroker::new(app.handle().clone())),
                audit: Arc::new(audit::AuditLog::new(
                    base_dir.join("audit.log"),
                    vault.clone(),
                )),
                ssh: Arc::new(ssh::SshManager::new()),
                snippets: Arc::new(snippets::SnippetStore::new(
                    base_dir.join("snippets.json"),
                    vault.clone(),
                )),
                transfers_dir: base_dir.join("ai-transfers"),
            };

            let token_path = base_dir.join("mcp_token");
            let token = vault::load_or_create_token(&token_path);
            let bearer: mcp::Bearer = Arc::new(std::sync::RwLock::new(token.clone()));
            let mcp = McpInfo {
                url: format!("http://127.0.0.1:{MCP_PORT}/mcp"),
                token: token.clone(),
                running: false,
            };

            let ct = tokio_util::sync::CancellationToken::new();

            let services_for_mcp = services.clone();
            let bearer_for_mcp = bearer.clone();
            app.manage(AppState {
                services,
                mcp: Mutex::new(mcp),
                mcp_cancel: ct.clone(),
                mcp_bearer: bearer,
                mcp_token_path: token_path,
            });
            app.manage(terminal::Sessions::default());
            app.manage(sftp::SftpSessions::default());

            let mcp_handle = app.handle().clone();
            let reset_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::serve(mcp_handle, services_for_mcp, bearer_for_mcp, MCP_PORT, ct).await {
                    tracing::error!("MCP-Server gestoppt: {e}");
                }
                if let Some(state) = reset_handle.try_state::<AppState>() {
                    if let Ok(mut info) = state.mcp.lock() {
                        info.running = false;
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_exists,
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_import,
            commands::vault_change_master,
            commands::secret_put,
            commands::secret_list,
            commands::secret_delete,
            commands::secret_reveal,
            commands::generate_key,
            commands::derive_pubkey,
            commands::drag_icon_path,
            commands::host_list,
            commands::host_add,
            commands::host_update,
            commands::host_remove,
            commands::host_set_policy,
            commands::host_set_file_policy,
            commands::ai_status,
            commands::ai_enable,
            commands::ai_disable,
            commands::ai_caps,
            commands::ai_set_caps,
            commands::approval_respond,
            commands::audit_list,
            commands::audit_user_command,
            commands::snippet_list,
            commands::snippet_add,
            commands::snippet_update,
            commands::snippet_delete,
            commands::mcp_info,
            commands::mcp_rotate_token,
            commands::mcp_connect_claude_code,
            commands::install_skill,
            commands::uninstall_skill,
            commands::skill_installed,
            commands::data_warnings,
            commands::mcp_list_registrations,
            commands::mcp_remove_registration,
            commands::run_command_ui,
            commands::sftp_open,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_download_dir,
            commands::sftp_upload,
            commands::sftp_upload_dir,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_close,
            terminal::ssh_open_shell,
            terminal::ssh_write,
            terminal::ssh_resize,
            terminal::ssh_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.mcp_cancel.cancel();
                }
            }
        });
}
