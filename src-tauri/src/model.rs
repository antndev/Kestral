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
        }
    }
}
