use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

/// Ein Protokolleintrag ueber eine KI-Aktion.
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub host_id: String,
    pub host_name: String,
    pub command: String,
    /// "allowed", "approved", "denied" oder "error".
    pub decision: String,
    pub exit_status: Option<i32>,
    pub success: bool,
    pub detail: Option<String>,
}

/// Maximale Anzahl im Speicher gehaltener Eintraege (gegen unbegrenztes Wachstum).
const MAX_ENTRIES: usize = 5000;

/// In-Memory-Protokoll aller KI-Aktionen. Persistenz auf Platte kommt spaeter.
pub struct AuditLog {
    entries: Mutex<Vec<AuditEntry>>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
        }
    }

    pub fn record(
        &self,
        host_id: String,
        host_name: String,
        command: String,
        decision: &str,
        exit_status: Option<i32>,
        success: bool,
        detail: Option<String>,
    ) {
        let entry = AuditEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            host_id,
            host_name,
            command,
            decision: decision.to_string(),
            exit_status,
            success,
            detail,
        };
        // Nur unkritische Felder loggen, nicht den ganzen Eintrag (command/detail
        // koennen vom Nutzer eingefuegte sensible Inhalte enthalten).
        tracing::info!(
            target: "audit",
            id = %entry.id,
            host = %entry.host_name,
            decision = %entry.decision,
            success = entry.success,
            "KI-Aktion"
        );
        let mut entries = self.entries.lock().unwrap();
        entries.push(entry);
        let len = entries.len();
        if len > MAX_ENTRIES {
            entries.drain(0..len - MAX_ENTRIES);
        }
    }

    /// Alle Eintraege (fuer die UI-Anzeige).
    pub fn list(&self) -> Vec<AuditEntry> {
        self.entries.lock().unwrap().clone()
    }

    /// Nur KI-relevante Eintraege. Vom Nutzer selbst getippte Terminal-Befehle
    /// (decision == "user") werden ausgeschlossen, damit die KI ueber
    /// get_audit_log NIE die manuelle Shell-Historie des Nutzers mitliest.
    pub fn list_ai(&self) -> Vec<AuditEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.decision != "user")
            .cloned()
            .collect()
    }
}

impl Default for AuditLog {
    fn default() -> Self {
        Self::new()
    }
}
