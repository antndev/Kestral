use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::approval::ApprovalBroker;
use crate::audit::AuditLog;
use crate::error::{AppError, Result};
use crate::hosts::HostStore;
use crate::model::Host;
use crate::policy::{DeniedReason, Gate, PolicyEngine};
use crate::sftp::{self, FileEntry};
use crate::snippets::SnippetStore;
use crate::ssh::{CommandOutput, SshManager};
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    pub url: String,
    pub token: String,
    pub running: bool,
}

#[derive(Clone)]
pub struct Services {
    pub vault: Arc<Vault>,
    pub hosts: Arc<HostStore>,
    pub policy: Arc<PolicyEngine>,
    pub approval: Arc<ApprovalBroker>,
    pub audit: Arc<AuditLog>,
    pub ssh: Arc<SshManager>,
    pub snippets: Arc<SnippetStore>,
    pub transfers_dir: PathBuf,
}

fn confine_ai_path(base: &Path, user_path: &str) -> Result<PathBuf> {
    let raw = Path::new(user_path);
    if raw.as_os_str().is_empty() {
        return Err(AppError::PathNotAllowed("empty path".into()));
    }
    if raw.is_absolute() {
        return Err(AppError::PathNotAllowed(format!(
            "'{user_path}' is absolute; AI transfers use a name relative to {}",
            base.display()
        )));
    }
    for comp in raw.components() {
        match comp {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => {
                return Err(AppError::PathNotAllowed(format!(
                    "'{user_path}' must be a plain relative name without '..' or a drive"
                )))
            }
        }
    }
    std::fs::create_dir_all(base)
        .map_err(|e| AppError::PathNotAllowed(format!("transfer dir {}: {e}", base.display())))?;
    crate::util::restrict_dir(base);
    let base_c = base
        .canonicalize()
        .map_err(|e| AppError::PathNotAllowed(format!("transfer dir {}: {e}", base.display())))?;
    let joined = base_c.join(raw);
    if let Some(parent) = joined.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut probe = joined.clone();
    loop {
        if probe.exists() {
            let real = probe
                .canonicalize()
                .map_err(|e| AppError::PathNotAllowed(format!("{user_path}: {e}")))?;
            if !real.starts_with(&base_c) {
                return Err(AppError::PathNotAllowed(format!(
                    "'{user_path}' resolves outside the AI transfer directory"
                )));
            }
            break;
        }
        if !probe.pop() {
            break;
        }
    }
    Ok(joined)
}

impl Services {
    pub async fn ai_run_command(&self, host_id: Uuid, command: &str) -> Result<CommandOutput> {
        let host = self.hosts.get(host_id)?;
        let host_id_s = host.id.to_string();

        match self.policy.gate(host.ai_policy) {
            Gate::Denied(reason) => {
                self.record_denied(&host_id_s, &host.name, command, reason);
                Err(reason_to_err(reason))
            }
            Gate::NeedsApproval => {
                let approved = self
                    .approval
                    .request(host_id_s.clone(), host.name.clone(), command.to_string())
                    .await;
                if !approved {
                    self.audit.record(
                        host_id_s,
                        host.name.clone(),
                        command.to_string(),
                        "denied",
                        None,
                        false,
                        Some("vom nutzer abgelehnt".to_string()),
                    );
                    return Err(AppError::ApprovalDenied);
                }
                let host = self.hosts.get(host_id)?;
                match self.policy.gate(host.ai_policy) {
                    Gate::Denied(reason) => {
                        self.record_denied(&host_id_s, &host.name, command, reason);
                        Err(reason_to_err(reason))
                    }
                    _ => self.execute_and_record(&host, command, "approved").await,
                }
            }
            Gate::Allowed => self.execute_and_record(&host, command, "allowed").await,
        }
    }

    fn record_denied(&self, host_id: &str, host_name: &str, command: &str, reason: DeniedReason) {
        let text = match reason {
            DeniedReason::HostLocked => "host gesperrt",
            DeniedReason::AiInactive => "ki aus",
        };
        self.audit.record(
            host_id.to_string(),
            host_name.to_string(),
            command.to_string(),
            "denied",
            None,
            false,
            Some(text.to_string()),
        );
    }

    async fn execute_and_record(
        &self,
        host: &crate::model::Host,
        command: &str,
        decision: &str,
    ) -> Result<CommandOutput> {
        let result = self.ssh.run_command(host, &self.vault, command).await;
        match &result {
            Ok(out) => {
                let success = out.exit_signal.is_none() && out.exit_status == Some(0);
                let detail = out
                    .exit_signal
                    .as_ref()
                    .map(|s| format!("beendet durch Signal {s}"));
                self.audit.record(
                    host.id.to_string(),
                    host.name.clone(),
                    command.to_string(),
                    decision,
                    out.exit_status,
                    success,
                    detail,
                );
            }
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                command.to_string(),
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
        result
    }

    async fn authorize_file(&self, host_id: Uuid, action: &str) -> Result<(Host, &'static str)> {
        let host = self.hosts.get(host_id)?;
        let hid = host.id.to_string();
        match self.policy.gate(host.ai_file_policy) {
            Gate::Denied(reason) => {
                self.record_denied(&hid, &host.name, action, reason);
                Err(reason_to_err(reason))
            }
            Gate::NeedsApproval => {
                let approved = self
                    .approval
                    .request(hid.clone(), host.name.clone(), action.to_string())
                    .await;
                if !approved {
                    self.audit.record(
                        hid,
                        host.name.clone(),
                        action.to_string(),
                        "denied",
                        None,
                        false,
                        Some("vom nutzer abgelehnt".to_string()),
                    );
                    return Err(AppError::ApprovalDenied);
                }
                let host = self.hosts.get(host_id)?;
                match self.policy.gate(host.ai_file_policy) {
                    Gate::Denied(reason) => {
                        self.record_denied(&hid, &host.name, action, reason);
                        Err(reason_to_err(reason))
                    }
                    _ => Ok((host, "approved")),
                }
            }
            Gate::Allowed => Ok((host, "allowed")),
        }
    }

    fn audit_file(&self, host: &Host, action: &str, decision: &str, result: &Result<u64>) {
        match result {
            Ok(bytes) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action.to_string(),
                decision,
                None,
                true,
                Some(format!("{bytes} bytes")),
            ),
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action.to_string(),
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
    }

    pub async fn ai_sftp_list(&self, host_id: Uuid, path: &str) -> Result<Vec<FileEntry>> {
        let action = format!("sftp list {path}");
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result = sftp::one_shot_list(&self.ssh, &self.vault, &host, path).await;
        match &result {
            Ok(entries) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action,
                decision,
                None,
                true,
                Some(format!("{} entries", entries.len())),
            ),
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action,
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
        result
    }

    pub async fn ai_sftp_download(&self, host_id: Uuid, remote: &str, local: &str) -> Result<u64> {
        let action = format!("sftp download {remote} -> {local}");
        let safe_local = confine_ai_path(&self.transfers_dir, local)?;
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result =
            sftp::one_shot_download(&self.ssh, &self.vault, &host, remote, &safe_local).await;
        self.audit_file(&host, &action, decision, &result);
        result
    }

    pub async fn ai_sftp_upload(&self, host_id: Uuid, local: &str, remote: &str) -> Result<u64> {
        let action = format!("sftp upload {local} -> {remote}");
        let safe_local = confine_ai_path(&self.transfers_dir, local)?;
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result =
            sftp::one_shot_upload(&self.ssh, &self.vault, &host, &safe_local, remote).await;
        self.audit_file(&host, &action, decision, &result);
        result
    }
}

fn reason_to_err(reason: DeniedReason) -> AppError {
    match reason {
        DeniedReason::HostLocked => AppError::HostLocked,
        DeniedReason::AiInactive => AppError::AiDisabled,
    }
}

pub struct AppState {
    pub services: Services,
    pub mcp: Mutex<McpInfo>,
    pub mcp_cancel: tokio_util::sync::CancellationToken,
    pub mcp_bearer: crate::mcp::Bearer,
    pub mcp_token_path: std::path::PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_transfer_path_cannot_escape_the_sandbox() {
        let base =
            std::env::temp_dir().join(format!("kestral_confine_{}", uuid::Uuid::new_v4()));

        assert!(confine_ai_path(&base, "note.txt").is_ok());
        assert!(confine_ai_path(&base, "sub/note.txt").is_ok());

        assert!(confine_ai_path(&base, "").is_err());
        assert!(confine_ai_path(&base, "../escape").is_err());
        assert!(confine_ai_path(&base, "a/../../escape").is_err());
        #[cfg(unix)]
        assert!(confine_ai_path(&base, "/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(confine_ai_path(&base, "C:/Windows/System32/x").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }
}
