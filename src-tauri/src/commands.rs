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
    let hosts = state.services.hosts.clone();
    let snippets = state.services.snippets.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || -> Result<()> {
        vault.create(master.as_str())?;
        if let Err(e) = hosts.load() {
            tracing::error!("Hosts nach Vault-Erstellung laden fehlgeschlagen: {e}");
        }
        if let Err(e) = snippets.load() {
            tracing::error!("Snippets nach Vault-Erstellung laden fehlgeschlagen: {e}");
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, master: String) -> Result<()> {
    let vault = state.services.vault.clone();
    let hosts = state.services.hosts.clone();
    let snippets = state.services.snippets.clone();
    let audit = state.services.audit.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || -> Result<()> {
        vault.unlock(master.as_str())?;
        if let Err(e) = hosts.load() {
            tracing::error!("Hosts nach Entsperren laden fehlgeschlagen: {e}");
        }
        if let Err(e) = snippets.load() {
            tracing::error!("Snippets nach Entsperren laden fehlgeschlagen: {e}");
        }
        audit.load();
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    state.services.vault.lock();
    state.services.hosts.clear();
    state.services.snippets.clear();
    state.services.audit.clear();
    Ok(())
}

#[tauri::command]
pub async fn vault_import(
    state: State<'_, AppState>,
    path: String,
    master: String,
) -> Result<Vec<String>> {
    let vault = state.services.vault.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || {
        vault.import_missing_from(std::path::Path::new(&path), master.as_str())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_change_master(
    state: State<'_, AppState>,
    current: String,
    new: String,
) -> Result<()> {
    let vault = state.services.vault.clone();
    let current = Zeroizing::new(current);
    let new = Zeroizing::new(new);
    tokio::task::spawn_blocking(move || -> Result<()> {
        vault.change_master(current.as_str(), new.as_str())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

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

#[derive(Serialize)]
pub struct PubkeyInfo {
    pub public_key: String,
    pub fingerprint: String,
}

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
pub async fn secret_reveal(state: State<'_, AppState>, id: String) -> Result<String> {
    let bytes = state.services.vault.get_secret(&id)?;
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Other("This credential is not valid UTF-8 text".into()))
}

#[tauri::command]
pub async fn generate_key(algorithm: Option<String>, comment: Option<String>) -> Result<String> {
    use rand::RngCore;
    use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData, PrivateKey};
    use russh::keys::ssh_key::LineEnding;

    match algorithm.as_deref().unwrap_or("ed25519") {
        "ed25519" => {}
        other => return Err(AppError::Ssh(format!("Unsupported key type: {other}"))),
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(seed.as_mut_slice());
    let key = PrivateKey::new(
        KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)),
        comment.unwrap_or_default(),
    )
    .map_err(|e| AppError::Ssh(format!("Key erzeugen: {e}")))?;

    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::Ssh(format!("Key kodieren: {e}")))?;
    Ok(pem.to_string())
}

#[tauri::command]
pub fn drag_icon_path() -> std::result::Result<String, String> {
    let path = std::env::temp_dir().join("kestral-drag-icon.png");
    if !path.exists() {
        let bytes = include_bytes!("../icons/32x32.png");
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn secret_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.services.vault.delete_secret(&id)
}

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

#[tauri::command]
pub async fn ai_caps(state: State<'_, AppState>) -> Result<crate::policy::AiCaps> {
    Ok(state.services.policy.caps())
}

#[tauri::command]
pub async fn ai_set_caps(state: State<'_, AppState>, caps: crate::policy::AiCaps) -> Result<()> {
    state.services.policy.set_caps(caps);
    Ok(())
}

#[tauri::command]
pub async fn approval_respond(
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<()> {
    state.services.approval.resolve(&id, approved);
    Ok(())
}

#[tauri::command]
pub async fn audit_list(state: State<'_, AppState>) -> Result<Vec<AuditEntry>> {
    Ok(state.services.audit.list())
}

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

#[tauri::command]
pub async fn mcp_info(state: State<'_, AppState>) -> Result<McpInfo> {
    Ok(state.mcp.lock().unwrap().clone())
}

#[derive(Serialize)]
pub struct RotateResult {
    pub info: McpInfo,
    pub reconnected: bool,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_rotate_token(state: State<'_, AppState>, name: String) -> Result<RotateResult> {
    let new_token = crate::vault::random_token();
    crate::util::atomic_write(&state.mcp_token_path, new_token.as_bytes())?;
    {
        let mut b = state
            .mcp_bearer
            .write()
            .map_err(|_| AppError::Other("Token lock poisoned".into()))?;
        *b = new_token.clone();
    }
    let info = {
        let mut i = state.mcp.lock().unwrap();
        i.token = new_token.clone();
        i.clone()
    };

    let name = server_name(name);
    let url = info.url.clone();
    let (reconnected, message) = tokio::task::spawn_blocking(move || {
        if !is_registered(&name) {
            return (
                false,
                "New token active. No Claude Code registration found, nothing to update.".to_string(),
            );
        }
        match register_claude_code(&name, &url, &new_token) {
            Ok(_) => (
                true,
                "New token active and Claude Code re-registered. Start a new Claude session."
                    .to_string(),
            ),
            Err(e) => (
                false,
                format!("New token active, but updating Claude Code failed: {e}"),
            ),
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;

    Ok(RotateResult {
        info,
        reconnected,
        message,
    })
}

#[derive(Serialize)]
pub struct ConnectResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_connect_claude_code(state: State<'_, AppState>, name: String) -> Result<ConnectResult> {
    let (url, token) = {
        let info = state.mcp.lock().unwrap();
        (info.url.clone(), info.token.clone())
    };
    let name = server_name(name);

    let out = tokio::task::spawn_blocking(move || register_claude_code(&name, &url, &token))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;

    Ok(match out {
        Ok(text) => ConnectResult {
            ok: true,
            message: format!(
                "{}\nStart a new Claude session so the tools get loaded.",
                text.trim()
            ),
        },
        Err(e) => ConnectResult {
            ok: false,
            message: e,
        },
    })
}

#[tauri::command]
pub async fn install_skill(state: State<'_, AppState>) -> Result<crate::skill::InstallResult> {
    let _ = state;
    tokio::task::spawn_blocking(crate::skill::install)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn uninstall_skill() -> Result<String> {
    tokio::task::spawn_blocking(crate::skill::uninstall)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn skill_installed() -> Result<bool> {
    Ok(crate::skill::installed())
}

#[derive(Serialize)]
pub struct Registration {
    pub name: String,
    pub url: String,
    pub connected: bool,
    pub is_this_app: bool,
}

#[tauri::command]
pub async fn mcp_list_registrations(state: State<'_, AppState>) -> Result<Vec<Registration>> {
    let my_url = state.mcp.lock().unwrap().url.clone();
    let text = tokio::task::spawn_blocking(|| run_claude(&["mcp", "list"]))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .unwrap_or_default();

    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        if name.is_empty() || name.contains(' ') {
            continue;
        }
        let url = rest.split_whitespace().next().unwrap_or("").to_string();
        if !url.starts_with("http") {
            continue;
        }
        out.push(Registration {
            is_this_app: url == my_url,
            connected: rest.contains("Connected") && !rest.contains("Failed"),
            name: name.to_string(),
            url,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_remove_registration(name: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        run_claude(&["mcp", "remove", name.as_str(), "--scope", "user"])
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map_err(AppError::Other)
}

#[tauri::command]
pub async fn data_warnings(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok([
        state.services.hosts.warning(),
        state.services.snippets.warning(),
    ]
    .into_iter()
    .flatten()
    .collect())
}

fn server_name(name: String) -> String {
    let n = name.trim();
    if n.is_empty() {
        "kestral".to_string()
    } else {
        n.to_string()
    }
}

fn is_registered(name: &str) -> bool {
    run_claude(&["mcp", "get", name]).is_ok()
}

fn register_claude_code(name: &str, url: &str, token: &str) -> std::result::Result<String, String> {
    let header = format!("Authorization: Bearer {token}");
    let _ = run_claude(&["mcp", "remove", name, "--scope", "user"]);
    run_claude(&[
        "mcp",
        "add",
        "--transport",
        "http",
        name,
        url,
        "--header",
        header.as_str(),
        "--scope",
        "user",
    ])
}

fn run_claude(args: &[&str]) -> std::result::Result<String, String> {
    let mut cmd = std::process::Command::new("claude");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Die Claude-CLI wurde nicht gefunden. Ist `claude` installiert und im PATH?".to_string()
        } else {
            format!("Claude-CLI konnte nicht gestartet werden: {e}")
        }
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if err.is_empty() { so } else { err })
    }
}

#[tauri::command]
pub async fn run_command_ui(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
    pty: Option<bool>,
) -> Result<CommandOutput> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let out = state
        .services
        .ssh
        .run_command_opts(&host, &state.services.vault, &command, pty.unwrap_or(false))
        .await;

    match &out {
        Ok(o) => state.services.audit.record(
            host.id.to_string(),
            host.name.clone(),
            command.clone(),
            "user",
            o.exit_status,
            o.exit_signal.is_none() && o.exit_status == Some(0),
            None,
        ),
        Err(e) => state.services.audit.record(
            host.id.to_string(),
            host.name.clone(),
            command.clone(),
            "user",
            None,
            false,
            Some(e.to_string()),
        ),
    }
    out
}

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
pub async fn sftp_download_dir(
    sessions: State<'_, SftpSessions>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .download_dir(&remote, std::path::Path::new(&local))
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
pub async fn sftp_upload_dir(
    sessions: State<'_, SftpSessions>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .upload_dir(std::path::Path::new(&local), &remote)
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
