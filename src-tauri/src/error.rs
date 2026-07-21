use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Vault is locked")]
    VaultLocked,
    #[error("Vault already exists")]
    VaultExists,
    #[error("Vault does not exist yet")]
    VaultMissing,
    #[error("Wrong master password or corrupted vault")]
    VaultAuth,
    #[error("Not found: {0}")]
    NotFound(String),
    #[allow(dead_code)]
    #[error("AI access is off")]
    AiDisabled,
    #[allow(dead_code)]
    #[error("Host is blocked for the AI")]
    HostLocked,
    #[allow(dead_code)]
    #[error("Approval denied")]
    ApprovalDenied,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Crypto error")]
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
