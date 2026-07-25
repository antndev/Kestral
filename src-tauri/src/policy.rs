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
}

pub struct PolicyEngine {
    inner: Mutex<Inner>,
    state_path: PathBuf,
}

impl PolicyEngine {
    const MAX_MINUTES: i64 = 24 * 60;

    pub fn new(state_path: PathBuf) -> Self {
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
        Self {
            inner: Mutex::new(Inner {
                enabled,
                expires_at,
                default_minutes: 30,
                caps: AiCaps::default(),
            }),
            state_path,
        }
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
