use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPolicy {
    Locked,
    Confirm,
    Free,
}

impl Default for AiPolicy {
    fn default() -> Self {
        AiPolicy::Locked
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AuthMethod {
    Password { secret_id: String },
    Key { secret_id: String },
    Agent,
}

fn default_local_host() -> String {
    "127.0.0.1".to_string()
}

/// A local port forward (like `ssh -L`). Kestral listens on `local_host:local_port`
/// and tunnels each connection to `remote_host:remote_port` as seen from the SSH
/// host. `local_host` defaults to loopback; set it to 0.0.0.0 or a LAN address to
/// let other devices on the network reach the tunnel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: Uuid,
    #[serde(default = "default_local_host")]
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub autostart: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: Uuid,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub ai_policy: AiPolicy,
    #[serde(default)]
    pub ai_file_policy: AiPolicy,
    #[serde(default)]
    pub forward_agent: bool,
    /// Vault secret IDs exposed to the in-process agent when forward_agent is on.
    #[serde(default)]
    pub agent_keys: Vec<String>,
    #[serde(default)]
    pub forwards: Vec<PortForward>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewHost {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub ai_policy: AiPolicy,
    #[serde(default)]
    pub ai_file_policy: AiPolicy,
    #[serde(default)]
    pub forward_agent: bool,
    #[serde(default)]
    pub agent_keys: Vec<String>,
    #[serde(default)]
    pub forwards: Vec<PortForward>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub label: String,
    pub script: String,
    #[serde(default)]
    pub target_host_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewSnippet {
    pub label: String,
    pub script: String,
    #[serde(default)]
    pub target_host_ids: Vec<Uuid>,
}

impl NewSnippet {
    pub fn into_snippet(self) -> Snippet {
        Snippet {
            id: Uuid::new_v4(),
            label: self.label,
            script: self.script,
            target_host_ids: self.target_host_ids,
        }
    }
}

impl NewHost {
    pub fn into_host(self) -> Host {
        Host {
            id: Uuid::new_v4(),
            name: self.name,
            hostname: self.hostname,
            port: self.port,
            username: self.username,
            auth: self.auth,
            ai_policy: self.ai_policy,
            ai_file_policy: self.ai_file_policy,
            forward_agent: self.forward_agent,
            agent_keys: self.agent_keys,
            forwards: self.forwards,
        }
    }
}
