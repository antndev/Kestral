mod approval;
mod audit;
mod commands;
mod error;
mod hosts;
mod mcp;
mod model;
mod policy;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().try_init().ok();

    tauri::Builder::default()
        // Single-Instance muss als erstes Plugin registriert werden.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let base_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&base_dir);
            let vault_path = base_dir.join("vault.json");

            let services = Services {
                vault: Arc::new(vault::Vault::new(vault_path)),
                hosts: Arc::new(hosts::HostStore::new(base_dir.join("hosts.json"))),
                policy: Arc::new(policy::PolicyEngine::new()),
                approval: Arc::new(approval::ApprovalBroker::new(app.handle().clone())),
                audit: Arc::new(audit::AuditLog::new()),
                ssh: Arc::new(ssh::SshManager::new()),
                snippets: Arc::new(snippets::SnippetStore::new(base_dir.join("snippets.json"))),
            };

            let token = vault::load_or_create_token(&base_dir.join("mcp_token"));
            let mcp = McpInfo {
                url: format!("http://127.0.0.1:{MCP_PORT}/mcp"),
                token: token.clone(),
                running: false,
            };

            // Ein Token steuert das saubere Herunterfahren des MCP-Servers.
            let ct = tokio_util::sync::CancellationToken::new();

            let services_for_mcp = services.clone();
            app.manage(AppState {
                services,
                mcp: Mutex::new(mcp),
                mcp_cancel: ct.clone(),
            });
            app.manage(terminal::Sessions::default());

            // Eingebauten MCP-Server als Hintergrund-Task starten.
            let mcp_handle = app.handle().clone();
            let reset_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::serve(mcp_handle, services_for_mcp, token, MCP_PORT, ct).await {
                    tracing::error!("MCP-Server gestoppt: {e}");
                }
                // serve hat beendet (Fehler oder Abbruch): Status zuruecksetzen.
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
            commands::secret_put,
            commands::secret_list,
            commands::secret_delete,
            commands::host_list,
            commands::host_add,
            commands::host_update,
            commands::host_remove,
            commands::host_set_policy,
            commands::ai_status,
            commands::ai_enable,
            commands::ai_disable,
            commands::approval_respond,
            commands::audit_list,
            commands::audit_user_command,
            commands::snippet_list,
            commands::snippet_add,
            commands::snippet_update,
            commands::snippet_delete,
            commands::mcp_info,
            commands::run_command_ui,
            terminal::ssh_open_shell,
            terminal::ssh_write,
            terminal::ssh_resize,
            terminal::ssh_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Beim Schliessen den MCP-Server-Task sauber abbrechen.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.mcp_cancel.cancel();
                }
            }
        });
}
