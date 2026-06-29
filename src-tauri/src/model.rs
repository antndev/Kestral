use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Pro Host waehlbare KI-Stufe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPolicy {
    /// KI darf hier gar nichts.
    Locked,
    /// Jeder Befehl muss vom Nutzer bestaetigt werden.
    Confirm,
    /// KI darf frei arbeiten.
    Free,
}

impl Default for AiPolicy {
    fn default() -> Self {
        AiPolicy::Locked
    }
}

/// Login-Art eines Hosts. Geheimnisse liegen nur als Verweis (`secret_id`) vor,
/// der eigentliche Wert kommt aus dem Tresor und verlaesst den Kern nie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AuthMethod {
    Password { secret_id: String },
    Key { secret_id: String },
    Agent,
}

/// Ein konfigurierter Server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: Uuid,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// KI-Stufe fuer Befehle (run_command).
    #[serde(default)]
    pub ai_policy: AiPolicy,
    /// Separate KI-Stufe fuer Dateizugriff (SFTP). Eigener Opt-In, standardmaessig
    /// gesperrt, unabhaengig von der Befehls-Policy.
    #[serde(default)]
    pub ai_file_policy: AiPolicy,
}

/// Eingabe aus dem UI zum Anlegen eines Hosts (ohne id).
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

/// Ein benanntes Skript, das auf bestimmten Hosts ausgefuehrt werden kann.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub label: String,
    pub script: String,
    /// Hosts, auf die sich das Snippet bezieht. Wird automatisch bereinigt,
    /// wenn ein Host geloescht wird.
    #[serde(default)]
    pub target_host_ids: Vec<Uuid>,
}

/// Eingabe aus dem UI zum Anlegen eines Snippets (ohne id).
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
