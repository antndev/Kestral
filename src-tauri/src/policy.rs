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
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                enabled: false,
                expires_at: None,
                default_minutes: 30,
                caps: AiCaps::default(),
            }),
        }
    }

    const MAX_MINUTES: i64 = 24 * 60;

    pub fn enable(&self, minutes: Option<i64>) {
        let mut inner = self.inner.lock().unwrap();
        let mins = minutes
            .unwrap_or(inner.default_minutes)
            .clamp(1, Self::MAX_MINUTES);
        inner.enabled = true;
        inner.expires_at = Some(Utc::now() + Duration::minutes(mins));
    }

    pub fn disable(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.enabled = false;
        inner.expires_at = None;
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

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}
