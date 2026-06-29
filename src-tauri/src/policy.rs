use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::model::AiPolicy;

/// Grund einer Ablehnung, damit der Aufrufer ihn nicht erneut (und ggf. mit
/// abweichendem Ergebnis) ermitteln muss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeniedReason {
    /// KI-Zugriff global aus oder Timer abgelaufen.
    AiInactive,
    /// Dieser Host ist fuer die KI gesperrt.
    HostLocked,
}

/// Ergebnis der Pruefung, ob eine KI-Aktion laufen darf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Allowed,
    NeedsApproval,
    Denied(DeniedReason),
}

/// Status des globalen KI-Schalters fuer das UI.
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
}

/// Haelt den globalen KI-Schalter und den Auto-Aus-Timer.
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
            }),
        }
    }

    /// Obergrenze fuer die Freischaltdauer (24h). Verhindert, dass eine extreme
    /// Eingabe `Duration::minutes`/`Utc::now() +` zum Ueberlauf-Panic bringt und
    /// dabei den Mutex vergiftet (was das Gate dauerhaft lahmlegen wuerde).
    const MAX_MINUTES: i64 = 24 * 60;

    /// Schaltet den KI-Zugriff fuer eine Dauer (Minuten) frei.
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

    /// Aktiv, solange eingeschaltet und der Timer nicht abgelaufen ist.
    /// Laeuft der Timer ab, wird der Schalter hier faul zurueckgesetzt.
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

    /// Liefert active und expires_at konsistent unter einem einzigen Lock.
    pub fn status(&self) -> AiStatus {
        let mut inner = self.inner.lock().unwrap();
        let active = Self::check_active(&mut inner);
        AiStatus {
            active,
            expires_at: inner.expires_at,
            default_minutes: inner.default_minutes,
        }
    }

    /// Entscheidet anhand des globalen Schalters und der Host-Stufe.
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
