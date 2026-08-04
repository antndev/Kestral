use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::model::AiPolicy;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AiCaps {
    pub list_hosts: bool,
    pub manage_hosts: bool,
    pub list_snippets: bool,
    pub manage_snippets: bool,
    pub list_secrets: bool,
    pub audit_log: bool,
}

impl Default for AiCaps {
    fn default() -> Self {
        Self {
            list_hosts: true,
            manage_hosts: false,
            list_snippets: true,
            manage_snippets: false,
            list_secrets: true,
            audit_log: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeniedReason {
    AiInactive,
    HostLocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Allowed,
    NeedsApproval,
    Denied(DeniedReason),
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStatus {
    pub active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub default_minutes: i64,
}

struct Inner {
    enabled: bool,
    expires_at: Option<DateTime<Utc>>,
    default_minutes: i64,
    caps: AiCaps,
    protected: Vec<String>,
}

pub struct PolicyEngine {
    inner: Mutex<Inner>,
    state_path: PathBuf,
    protected_path: PathBuf,
}

/// Paths the AI must never write to, unless the user changes the list. These
/// are the classic footholds: adding a key to authorized_keys or rewriting the
/// SSH client config.
fn default_protected() -> Vec<String> {
    vec![
        ".ssh/authorized_keys".to_string(),
        ".ssh/config".to_string(),
    ]
}

/// True if `path` is covered by the protection `pattern`. A pattern beginning
/// with `/` is anchored at the root; otherwise it matches as a trailing path
/// segment, so `.ssh/authorized_keys` covers `/home/x/.ssh/authorized_keys` and
/// `/root/.ssh/authorized_keys`. A directory pattern also protects everything
/// inside it.
fn path_matches(path: &str, pattern: &str) -> bool {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    let pat = pattern.trim().replace('\\', "/");
    let pat = pat.trim_end_matches('/');
    if pat.is_empty() {
        return false;
    }
    if let Some(abs) = pat.strip_prefix('/') {
        let abs = format!("/{abs}");
        path == abs || path.starts_with(&format!("{abs}/"))
    } else {
        path == pat
            || path.ends_with(&format!("/{pat}"))
            || path.starts_with(&format!("{pat}/"))
            || path.contains(&format!("/{pat}/"))
    }
}

impl PolicyEngine {
    const MAX_MINUTES: i64 = 24 * 60;

    pub fn new(state_path: PathBuf, protected_path: PathBuf) -> Self {
        let saved = std::fs::read_to_string(&state_path).unwrap_or_default();
        let (enabled, expires_at) = if saved.trim_start().starts_with("on") {
            let mins = saved
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(30)
                .clamp(1, Self::MAX_MINUTES);
            (true, Some(Utc::now() + Duration::minutes(mins)))
        } else {
            (false, None)
        };
        let protected = match std::fs::read_to_string(&protected_path) {
            Ok(s) => serde_json::from_str::<Vec<String>>(&s).unwrap_or_else(|_| default_protected()),
            Err(_) => default_protected(),
        };
        Self {
            inner: Mutex::new(Inner {
                enabled,
                expires_at,
                default_minutes: 30,
                caps: AiCaps::default(),
                protected,
            }),
            state_path,
            protected_path,
        }
    }

    pub fn protected_paths(&self) -> Vec<String> {
        self.inner.lock().unwrap().protected.clone()
    }

    pub fn set_protected_paths(&self, paths: Vec<String>) {
        let cleaned: Vec<String> = paths
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        self.inner.lock().unwrap().protected = cleaned.clone();
        if let Ok(json) = serde_json::to_string_pretty(&cleaned) {
            let _ = std::fs::write(&self.protected_path, json);
        }
    }

    /// True if AI writes to `path` are blocked by the protection list.
    pub fn is_protected(&self, path: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.protected.iter().any(|pat| path_matches(path, pat))
    }

    /// Best-effort tripwire for commands: true if a protected path appears in
    /// the command text. Catches the obvious `>> ~/.ssh/authorized_keys` route;
    /// a command is arbitrary, so this is a guardrail, not a sandbox.
    pub fn mentions_protected(&self, text: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .protected
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .any(|p| text.contains(p))
    }

    fn save(&self, on: bool, minutes: i64) {
        let _ = std::fs::write(
            &self.state_path,
            if on { format!("on {minutes}") } else { "off".to_string() },
        );
    }

    pub fn enable(&self, minutes: Option<i64>) {
        let mins = {
            let mut inner = self.inner.lock().unwrap();
            let mins = minutes
                .unwrap_or(inner.default_minutes)
                .clamp(1, Self::MAX_MINUTES);
            inner.enabled = true;
            inner.expires_at = Some(Utc::now() + Duration::minutes(mins));
            mins
        };
        self.save(true, mins);
    }

    pub fn disable(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.enabled = false;
            inner.expires_at = None;
        }
        self.save(false, 0);
    }

    fn check_active(inner: &mut Inner) -> bool {
        if inner.enabled {
            match inner.expires_at {
                Some(exp) if Utc::now() < exp => true,
                _ => {
                    inner.enabled = false;
                    inner.expires_at = None;
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn is_active(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        Self::check_active(&mut inner)
    }

    pub fn caps(&self) -> AiCaps {
        self.inner.lock().unwrap().caps
    }

    pub fn set_caps(&self, caps: AiCaps) {
        self.inner.lock().unwrap().caps = caps;
    }

    pub fn status(&self) -> AiStatus {
        let mut inner = self.inner.lock().unwrap();
        let active = Self::check_active(&mut inner);
        AiStatus {
            active,
            expires_at: inner.expires_at,
            default_minutes: inner.default_minutes,
        }
    }

    pub fn gate(&self, host_policy: AiPolicy) -> Gate {
        if !self.is_active() {
            return Gate::Denied(DeniedReason::AiInactive);
        }
        match host_policy {
            AiPolicy::Locked => Gate::Denied(DeniedReason::HostLocked),
            AiPolicy::Confirm => Gate::NeedsApproval,
            AiPolicy::Free => Gate::Allowed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(protected: &[&str]) -> PolicyEngine {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pp = dir.join("protected.json");
        std::fs::write(&pp, serde_json::to_string(protected).unwrap()).unwrap();
        PolicyEngine::new(dir.join("ai_state"), pp)
    }

    #[test]
    fn protects_ssh_files_across_home_directories() {
        let p = engine(&[".ssh/authorized_keys", ".ssh/config"]);
        assert!(p.is_protected("/home/anton/.ssh/authorized_keys"));
        assert!(p.is_protected("/root/.ssh/authorized_keys"));
        assert!(p.is_protected("~/.ssh/config"));
        assert!(p.is_protected(".ssh/config"));
        // Unrelated files and look-alikes are not protected.
        assert!(!p.is_protected("/home/anton/.ssh/known_hosts"));
        assert!(!p.is_protected("/etc/myssh/config"));
    }

    #[test]
    fn absolute_and_directory_patterns() {
        let p = engine(&["/etc/passwd", ".ssh"]);
        assert!(p.is_protected("/etc/passwd"));
        assert!(!p.is_protected("/etc/passwd.bak"));
        assert!(p.is_protected("/home/x/.ssh"));
        assert!(p.is_protected("/home/x/.ssh/id_ed25519"));
    }

    #[test]
    fn command_tripwire_matches_written_paths() {
        let p = engine(&[".ssh/authorized_keys"]);
        assert!(p.mentions_protected("echo key >> ~/.ssh/authorized_keys"));
        assert!(p.mentions_protected("tee -a /root/.ssh/authorized_keys"));
        assert!(!p.mentions_protected("cat /etc/hostname"));
    }

    #[test]
    fn defaults_apply_when_no_file_exists() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), dir.join("missing.json"));
        assert!(p.is_protected("/root/.ssh/authorized_keys"));
        assert!(p.is_protected("/home/u/.ssh/config"));
    }
}
