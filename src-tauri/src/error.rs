use serde::{Serialize, Serializer};

/// Zentraler Fehlertyp. Wird an das Frontend als einfacher Text serialisiert,
/// damit `invoke` im UI einen lesbaren Grund bekommt.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Tresor ist gesperrt")]
    VaultLocked,
    #[error("Tresor existiert bereits")]
    VaultExists,
    #[error("Tresor existiert noch nicht")]
    VaultMissing,
    #[error("falsches Master-Passwort oder beschaedigter Tresor")]
    VaultAuth,
    #[error("nicht gefunden: {0}")]
    NotFound(String),
    // Die drei folgenden werden vom MCP-Ablauf (Stufe 3) erzeugt.
    #[allow(dead_code)]
    #[error("KI-Zugriff ist aus")]
    AiDisabled,
    #[allow(dead_code)]
    #[error("Host ist fuer die KI gesperrt")]
    HostLocked,
    #[allow(dead_code)]
    #[error("Freigabe abgelehnt")]
    ApprovalDenied,
    #[error("E/A-Fehler: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialisierungsfehler: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Krypto-Fehler")]
    Crypto,
    #[error("SSH: {0}")]
    Ssh(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
