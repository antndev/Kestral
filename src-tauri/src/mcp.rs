//! Eingebauter MCP-Server (Streamable HTTP auf 127.0.0.1).
//!
//! Bietet einer KI (z.B. Claude Code) drei Werkzeuge an: list_hosts, run_command,
//! get_audit_log. run_command laeuft IMMER ueber Services::ai_run_command, also
//! ueber das Gate (globaler Schalter, Auto-Aus) und ggf. die Freigabe. Private
//! Schluessel verlassen den Kern nie. Abgesichert per Bearer-Token, Loopback-Bind
//! und der eingebauten Host/Origin-Pruefung von rmcp.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::model::{AiPolicy, AuthMethod, Host, NewHost, NewSnippet, Snippet};
use crate::state::Services;
use crate::vault::SecretStore;

/// Reduzierte Host-Ansicht fuer die KI (keine Geheimnis-Verweise).
#[derive(Serialize)]
struct HostView {
    id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    ai_policy: AiPolicy,
    ai_file_policy: AiPolicy,
}

/// Baut eine AuthMethod aus den von der KI gelieferten Feldern. Die KI gibt nie
/// einen Geheimniswert, sie referenziert nur eine bestehende secret_id.
fn build_auth(kind: &str, secret_id: Option<String>) -> std::result::Result<AuthMethod, String> {
    match kind {
        "password" => secret_id
            .map(|s| AuthMethod::Password { secret_id: s })
            .ok_or_else(|| "secret_id is required for auth_kind=password".to_string()),
        "key" => secret_id
            .map(|s| AuthMethod::Key { secret_id: s })
            .ok_or_else(|| "secret_id is required for auth_kind=key".to_string()),
        "agent" => Ok(AuthMethod::Agent),
        other => Err(format!("unknown auth_kind '{other}', use password, key or agent")),
    }
}

fn parse_host_ids(ids: &[String]) -> std::result::Result<Vec<Uuid>, String> {
    ids.iter()
        .map(|s| Uuid::parse_str(s).map_err(|_| format!("invalid host id: {s}")))
        .collect()
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunCommandArgs {
    /// Id of the host to run the command on (from list_hosts).
    host_id: String,
    /// Shell command to execute.
    command: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateHostArgs {
    /// Display name.
    name: String,
    /// Hostname or IP address.
    hostname: String,
    /// Port, usually 22.
    port: u16,
    /// SSH username.
    username: String,
    /// One of "password", "key" or "agent".
    auth_kind: String,
    /// Id of an existing credential from list_secrets. Required for password/key. The secret value is never seen or set by the AI.
    #[serde(default)]
    secret_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateHostArgs {
    /// Id of the host to update (from list_hosts).
    host_id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    /// One of "password", "key" or "agent".
    auth_kind: String,
    #[serde(default)]
    secret_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateSnippetArgs {
    /// Short label.
    label: String,
    /// Shell script body.
    script: String,
    /// Optional host ids this snippet targets.
    #[serde(default)]
    target_host_ids: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateSnippetArgs {
    /// Id of the snippet to update (from list_snippets).
    snippet_id: String,
    label: String,
    script: String,
    #[serde(default)]
    target_host_ids: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpListArgs {
    /// Id of the host (from list_hosts).
    host_id: String,
    /// Absolute remote directory path to list.
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpDownloadArgs {
    host_id: String,
    /// Remote file path to read.
    remote_path: String,
    /// Local destination path to write.
    local_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpUploadArgs {
    host_id: String,
    /// Local file path to read.
    local_path: String,
    /// Remote destination path to write.
    remote_path: String,
}

#[derive(Clone)]
pub struct HelmsmanMcp {
    services: Services,
    tool_router: ToolRouter<HelmsmanMcp>,
}

#[tool_router]
impl HelmsmanMcp {
    pub fn new(services: Services) -> Self {
        Self {
            services,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "List the configured SSH hosts (id, name, address, user, ai policy) as JSON.")]
    async fn list_hosts(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(CallToolResult::error(vec![Content::text(
                "AI access is disabled. Enable it in Helmsman first.",
            )]));
        }
        let views: Vec<HostView> = self
            .services
            .hosts
            .list()
            .into_iter()
            .map(|h| HostView {
                id: h.id.to_string(),
                name: h.name,
                hostname: h.hostname,
                port: h.port,
                username: h.username,
                ai_policy: h.ai_policy,
                ai_file_policy: h.ai_file_policy,
            })
            .collect();
        let json = serde_json::to_string_pretty(&views).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        description = "Run a shell command on a host. Subject to the global AI switch and the per-host policy (may require user approval). Returns stdout, stderr and exit code."
    )]
    async fn run_command(
        &self,
        Parameters(RunCommandArgs { host_id, command }): Parameters<RunCommandArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match Uuid::parse_str(&host_id) {
            Ok(id) => id,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid host_id: {host_id}"
                ))]))
            }
        };
        match self.services.ai_run_command(id, &command).await {
            Ok(out) => {
                let status = match (&out.exit_signal, out.exit_status) {
                    (Some(sig), _) => format!("signal {sig}"),
                    (None, Some(code)) => code.to_string(),
                    (None, None) => "?".into(),
                };
                let text = format!(
                    "exit: {status}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    out.stdout, out.stderr
                );
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Return the audit log of AI-issued actions as JSON.")]
    async fn get_audit_log(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(CallToolResult::error(vec![Content::text(
                "AI access is disabled. Enable it in Helmsman first.",
            )]));
        }
        // Nur KI-Aktionen, nie die manuell getippte Shell-Historie des Nutzers.
        let entries = self.services.audit.list_ai();
        let json = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(description = "List saved snippets (id, label, script, target host ids) as JSON.")]
    async fn list_snippets(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        let items = self.services.snippets.list();
        let json = serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        description = "List credential ids and kinds. Never returns secret values. Use an id to wire a host to an existing credential."
    )]
    async fn list_secrets(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        match self.services.vault.list_secrets() {
            Ok(metas) => {
                let json = serde_json::to_string_pretty(&metas).unwrap_or_else(|_| "[]".into());
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Create a new SSH host. AI access stays locked by default; only the user can grant it. The AI never sets a secret value, it only references an existing credential id."
    )]
    async fn create_host(
        &self,
        Parameters(a): Parameters<CreateHostArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        let auth = match build_auth(&a.auth_kind, a.secret_id) {
            Ok(au) => au,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let new = NewHost {
            name: a.name,
            hostname: a.hostname,
            port: a.port,
            username: a.username,
            auth,
            ai_policy: AiPolicy::Locked,
            ai_file_policy: AiPolicy::Locked,
        };
        match self.services.hosts.add(new) {
            Ok(h) => {
                self.services.audit.record(
                    h.id.to_string(),
                    h.name.clone(),
                    format!("create host {}@{}:{}", h.username, h.hostname, h.port),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Created host '{}' with id {}. AI access is locked until the user enables it.",
                    h.name, h.id
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Update an existing host's connection fields. The per-host AI policies are preserved and cannot be changed by the AI."
    )]
    async fn update_host(
        &self,
        Parameters(a): Parameters<UpdateHostArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        let id = match Uuid::parse_str(&a.host_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid host_id: {}",
                    a.host_id
                ))]))
            }
        };
        let existing = match self.services.hosts.get(id) {
            Ok(h) => h,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        };
        let auth = match build_auth(&a.auth_kind, a.secret_id) {
            Ok(au) => au,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let updated = Host {
            id,
            name: a.name,
            hostname: a.hostname,
            port: a.port,
            username: a.username,
            auth,
            ai_policy: existing.ai_policy,
            ai_file_policy: existing.ai_file_policy,
        };
        match self.services.hosts.update(updated.clone()) {
            Ok(()) => {
                self.services.audit.record(
                    id.to_string(),
                    updated.name.clone(),
                    format!(
                        "update host {}@{}:{}",
                        updated.username, updated.hostname, updated.port
                    ),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Updated host '{}'.",
                    updated.name
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Create a snippet (named script), optionally tied to target hosts.")]
    async fn create_snippet(
        &self,
        Parameters(a): Parameters<CreateSnippetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        let targets = match parse_host_ids(&a.target_host_ids) {
            Ok(t) => t,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let new = NewSnippet {
            label: a.label,
            script: a.script,
            target_host_ids: targets,
        };
        match self.services.snippets.add(new) {
            Ok(s) => {
                self.services.audit.record(
                    s.id.to_string(),
                    s.label.clone(),
                    format!("create snippet '{}'", s.label),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Created snippet '{}' with id {}.",
                    s.label, s.id
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Update an existing snippet by id.")]
    async fn update_snippet(
        &self,
        Parameters(a): Parameters<UpdateSnippetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        let id = match Uuid::parse_str(&a.snippet_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid snippet_id: {}",
                    a.snippet_id
                ))]))
            }
        };
        let targets = match parse_host_ids(&a.target_host_ids) {
            Ok(t) => t,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let updated = Snippet {
            id,
            label: a.label,
            script: a.script,
            target_host_ids: targets,
        };
        match self.services.snippets.update(updated.clone()) {
            Ok(()) => {
                self.services.audit.record(
                    id.to_string(),
                    updated.label.clone(),
                    format!("update snippet '{}'", updated.label),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Updated snippet '{}'.",
                    updated.label
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "List a remote directory over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_list(
        &self,
        Parameters(a): Parameters<SftpListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match Uuid::parse_str(&a.host_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid host_id: {}",
                    a.host_id
                ))]))
            }
        };
        match self.services.ai_sftp_list(id, &a.path).await {
            Ok(entries) => {
                let json = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Download a remote file to a local path over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_download(
        &self,
        Parameters(a): Parameters<SftpDownloadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match Uuid::parse_str(&a.host_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid host_id: {}",
                    a.host_id
                ))]))
            }
        };
        match self
            .services
            .ai_sftp_download(id, &a.remote_path, &a.local_path)
            .await
        {
            Ok(n) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Downloaded {n} bytes to {}",
                a.local_path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Upload a local file to a remote path over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_upload(
        &self,
        Parameters(a): Parameters<SftpUploadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match Uuid::parse_str(&a.host_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid host_id: {}",
                    a.host_id
                ))]))
            }
        };
        match self
            .services
            .ai_sftp_upload(id, &a.local_path, &a.remote_path)
            .await
        {
            Ok(n) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Uploaded {n} bytes to {}",
                a.remote_path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    /// Standard-Fehlerantwort, wenn der KI-Zugriff global aus ist.
    fn disabled() -> CallToolResult {
        CallToolResult::error(vec![Content::text(
            "AI access is disabled. Enable it in Helmsman first.",
        )])
    }
}

// Das #[tool_handler]-Makro erzeugt call_tool/list_tools/get_tool und ein
// passendes get_info (das die Tools advertised), da wir keines selbst definieren.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for HelmsmanMcp {}

#[derive(Clone)]
struct AuthState {
    bearer: Arc<String>,
}

/// Bearer-Token-Pruefung. Claude Code sendet den Header
/// `Authorization: Bearer <token>`. Loopback-Bind plus rmcps eingebaute
/// Host/Origin-Pruefung uebernehmen den Rest.
async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<AuthState>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let expected = format!("Bearer {}", state.bearer);
    match headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        Some(v) if v == expected => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

fn build_router(services: Services, token: String, port: u16, ct: CancellationToken) -> Router {
    let service: StreamableHttpService<HelmsmanMcp, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(HelmsmanMcp::new(services.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default()
                .with_allowed_hosts([
                    "127.0.0.1".to_string(),
                    format!("127.0.0.1:{port}"),
                    "localhost".to_string(),
                    format!("localhost:{port}"),
                ])
                .with_cancellation_token(ct),
        );

    let auth = AuthState {
        bearer: Arc::new(token),
    };

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(auth, auth_middleware))
}

/// Startet den MCP-Server. Bei Erfolg wird McpInfo.running im State auf true gesetzt.
pub async fn serve(
    app: tauri::AppHandle,
    services: Services,
    token: String,
    port: u16,
    ct: CancellationToken,
) -> std::io::Result<()> {
    let router = build_router(services, token, port, ct.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;

    {
        use tauri::Manager;
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            if let Ok(mut info) = state.mcp.lock() {
                info.running = true;
            }
        }
    }

    tracing::info!("Helmsman MCP listening on http://127.0.0.1:{port}/mcp");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move { ct.cancelled().await })
        .await
}
