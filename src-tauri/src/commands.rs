use serde::Serialize;
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use std::sync::Arc;

use crate::audit::AuditEntry;
use crate::error::{AppError, Result};
use crate::model::{AiPolicy, Host, NewHost, NewSnippet, Snippet};
use crate::policy::AiStatus;
use crate::sftp::{FileEntry, SftpSessions};
use crate::ssh::CommandOutput;
use crate::state::{AppState, McpInfo};
use crate::vault::{SecretKind, SecretMeta, SecretStore};

fn parse_id(id: &str) -> Result<Uuid> {
    Uuid::parse_str(id).map_err(|_| AppError::NotFound(id.to_string()))
}

// --- Tresor ---

#[tauri::command]
pub async fn vault_exists(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.services.vault.exists())
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.services.vault.is_unlocked())
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, master: String) -> Result<()> {
    let vault = state.services.vault.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || vault.create(master.as_str()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, master: String) -> Result<()> {
    let vault = state.services.vault.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || vault.unlock(master.as_str()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    state.services.vault.lock();
    Ok(())
}

// --- Geheimnisse ---

#[tauri::command]
pub async fn secret_put(
    state: State<'_, AppState>,
    id: String,
    kind: SecretKind,
    value: String,
) -> Result<()> {
    let value = Zeroizing::new(value);
    state.services.vault.put_secret(&id, kind, value.as_bytes())
}

#[tauri::command]
pub async fn secret_list(state: State<'_, AppState>) -> Result<Vec<SecretMeta>> {
    state.services.vault.list_secrets()
}

/// Abgeleiteter Public Key und SHA256-Fingerprint zu einem Private Key.
#[derive(Serialize)]
pub struct PubkeyInfo {
    pub public_key: String,
    pub fingerprint: String,
}

/// Leitet aus einem (unverschluesselten) Private Key den OpenSSH-Public-Key und
/// dessen SHA256-Fingerprint ab. Der Private Key verlaesst den Kern nicht.
#[tauri::command]
pub async fn derive_pubkey(private_key: String) -> Result<PubkeyInfo> {
    let pk = Zeroizing::new(private_key);
    let key = russh::keys::decode_secret_key(pk.as_str(), None)
        .map_err(|e| AppError::Ssh(format!("Schluessel laden: {e}")))?;
    let public = key.public_key();
    let public_key = public
        .to_openssh()
        .map_err(|e| AppError::Ssh(format!("Public Key: {e}")))?;
    let fingerprint = public
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();
    Ok(PubkeyInfo {
        public_key,
        fingerprint,
    })
}

#[tauri::command]
pub async fn secret_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.services.vault.delete_secret(&id)
}

// --- Hosts ---

#[tauri::command]
pub async fn host_list(state: State<'_, AppState>) -> Result<Vec<Host>> {
    Ok(state.services.hosts.list())
}

#[tauri::command]
pub async fn host_add(state: State<'_, AppState>, host: NewHost) -> Result<Host> {
    state.services.hosts.add(host)
}

#[tauri::command]
pub async fn host_update(state: State<'_, AppState>, host: Host) -> Result<()> {
    state.services.hosts.update(host)
}

#[tauri::command]
pub async fn host_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    let hid = parse_id(&id)?;
    state.services.hosts.remove(hid)?;
    // Geloeschten Host aus allen Snippet-Zielen entfernen.
    state.services.snippets.remove_host(hid)?;
    Ok(())
}

#[tauri::command]
pub async fn host_set_policy(
    state: State<'_, AppState>,
    id: String,
    policy: AiPolicy,
) -> Result<()> {
    state.services.hosts.set_policy(parse_id(&id)?, policy)
}

#[tauri::command]
pub async fn host_set_file_policy(
    state: State<'_, AppState>,
    id: String,
    policy: AiPolicy,
) -> Result<()> {
    state.services.hosts.set_file_policy(parse_id(&id)?, policy)
}

// --- KI-Schalter ---

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus> {
    Ok(state.services.policy.status())
}

#[tauri::command]
pub async fn ai_enable(state: State<'_, AppState>, minutes: Option<i64>) -> Result<()> {
    state.services.policy.enable(minutes);
    Ok(())
}

#[tauri::command]
pub async fn ai_disable(state: State<'_, AppState>) -> Result<()> {
    state.services.policy.disable();
    Ok(())
}

// --- Freigabe ---

#[tauri::command]
pub async fn approval_respond(
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<()> {
    state.services.approval.resolve(&id, approved);
    Ok(())
}

// --- Protokoll ---

#[tauri::command]
pub async fn audit_list(state: State<'_, AppState>) -> Result<Vec<AuditEntry>> {
    Ok(state.services.audit.list())
}

/// Protokolliert einen vom Nutzer selbst (im Terminal) eingegebenen Befehl.
/// Best effort: das Frontend setzt Tastenanschlaege zu Zeilen zusammen.
#[tauri::command]
pub async fn audit_user_command(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
) -> Result<()> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    state.services.audit.record(
        host.id.to_string(),
        host.name,
        command,
        "user",
        None,
        true,
        None,
    );
    Ok(())
}

// --- Snippets ---

#[tauri::command]
pub async fn snippet_list(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    Ok(state.services.snippets.list())
}

#[tauri::command]
pub async fn snippet_add(state: State<'_, AppState>, snippet: NewSnippet) -> Result<Snippet> {
    state.services.snippets.add(snippet)
}

#[tauri::command]
pub async fn snippet_update(state: State<'_, AppState>, snippet: Snippet) -> Result<()> {
    state.services.snippets.update(snippet)
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.services.snippets.remove(parse_id(&id)?)
}

// --- MCP ---

#[tauri::command]
pub async fn mcp_info(state: State<'_, AppState>) -> Result<McpInfo> {
    Ok(state.mcp.lock().unwrap().clone())
}

// --- Manueller Lauf aus dem UI (kein KI-Gate, das ist der Nutzer selbst) ---

#[tauri::command]
pub async fn run_command_ui(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
) -> Result<CommandOutput> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    state
        .services
        .ssh
        .run_command(&host, &state.services.vault, &command)
        .await
}

// --- SFTP-Browser (Nutzer, kein KI-Gate) ---

fn sftp_handle(
    sessions: &SftpSessions,
    id: &str,
) -> Result<Arc<crate::sftp::SftpHandle>> {
    sessions
        .get(id)
        .ok_or_else(|| AppError::Other("SFTP-Sitzung nicht gefunden".into()))
}

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    sessions: State<'_, SftpSessions>,
    id: String,
    host_id: String,
) -> Result<String> {
    // Eine evtl. alte Sitzung gleicher id sauber schliessen.
    sessions.remove(&id);
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let handle = crate::sftp::connect(&state.services.ssh, &state.services.vault, &host).await?;
    let home = handle.home().await.unwrap_or_else(|_| "/".to_string());
    sessions.insert(id, Arc::new(handle));
    Ok(home)
}

#[tauri::command]
pub async fn sftp_list(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<Vec<FileEntry>> {
    sftp_handle(&sessions, &id)?.list(&path).await
}

#[tauri::command]
pub async fn sftp_download(
    sessions: State<'_, SftpSessions>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .download(&remote, std::path::Path::new(&local))
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    sessions: State<'_, SftpSessions>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .upload(std::path::Path::new(&local), &remote)
        .await
}

#[tauri::command]
pub async fn sftp_read_text(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<String> {
    sftp_handle(&sessions, &id)?.read_text(&path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
    content: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.write_text(&path, &content).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_remove(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.remove(&path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    sessions: State<'_, SftpSessions>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.rename(&from, &to).await
}

#[tauri::command]
pub async fn sftp_close(sessions: State<'_, SftpSessions>, id: String) -> Result<()> {
    sessions.remove(&id);
    Ok(())
}
