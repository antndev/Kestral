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

use crate::model::AiPolicy;
use crate::state::Services;

/// Reduzierte Host-Ansicht fuer die KI (keine Geheimnis-Verweise).
#[derive(Serialize)]
struct HostView {
    id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    ai_policy: AiPolicy,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunCommandArgs {
    /// Id of the host to run the command on (from list_hosts).
    host_id: String,
    /// Shell command to execute.
    command: String,
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
