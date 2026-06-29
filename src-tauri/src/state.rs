use std::sync::{Arc, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::approval::ApprovalBroker;
use crate::audit::AuditLog;
use crate::error::{AppError, Result};
use crate::hosts::HostStore;
use crate::policy::{DeniedReason, Gate, PolicyEngine};
use crate::snippets::SnippetStore;
use crate::ssh::{CommandOutput, SshManager};
use crate::vault::Vault;

/// Verbindungsdaten des lokalen MCP-Endpunkts fuer die Anzeige im UI.
#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    pub url: String,
    pub token: String,
    pub running: bool,
}

/// Gebuendelte Kern-Dienste. Wird sowohl vom UI (ueber `AppState`) als auch vom
/// MCP-Server genutzt. Alle Felder sind `Arc`, also billig klonbar.
#[derive(Clone)]
pub struct Services {
    pub vault: Arc<Vault>,
    pub hosts: Arc<HostStore>,
    pub policy: Arc<PolicyEngine>,
    pub approval: Arc<ApprovalBroker>,
    pub audit: Arc<AuditLog>,
    pub ssh: Arc<SshManager>,
    pub snippets: Arc<SnippetStore>,
}

impl Services {
    /// Der zentrale Ablauf fuer jede KI-Aktion: Gate pruefen, ggf. Freigabe
    /// einholen, ausfuehren, protokollieren. Gibt niemals Geheimnisse zurueck.
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
                // Nach der (bis zu 2 Min) Freigabe-Wartezeit erneut pruefen: der
                // Auto-Aus-Timer koennte abgelaufen oder der Host inzwischen
                // gesperrt sein. Sonst liefe der Befehl ausserhalb des Fensters.
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
}

fn reason_to_err(reason: DeniedReason) -> AppError {
    match reason {
        DeniedReason::HostLocked => AppError::HostLocked,
        DeniedReason::AiInactive => AppError::AiDisabled,
    }
}

/// Von Tauri verwalteter Zustand. Per Typ adressiert.
pub struct AppState {
    pub services: Services,
    pub mcp: Mutex<McpInfo>,
    /// Stoppt den MCP-Server beim Beenden der App sauber.
    pub mcp_cancel: tokio_util::sync::CancellationToken,
}
