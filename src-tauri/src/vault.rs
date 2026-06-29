//! Verschluesselter lokaler Schluesselspeicher.
//!
//! Aufbau: Eine Datei wird als Ganzes verschluesselt. Das Master-Passwort geht
//! durch Argon2id zu einem 32-Byte-Schluessel, damit wird der Inhalt mit
//! XChaCha20Poly1305 verschluesselt. Der Klartext-Header (Version, KDF-Parameter,
//! Salt, Nonce) wird als Associated Data in den Auth-Tag gebunden, damit niemand
//! die Parameter unbemerkt herabsetzen kann.
//!
//! Der ganze Zugriff laeuft hinter dem Trait [`SecretStore`], damit wir den
//! lokalen Tresor spaeter gegen Vaultwarden tauschen koennen, ohne die Aufrufer
//! anzufassen.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

// Argon2id-Parameter. Balance aus Sicherheit und schnellem Desktop-Entsperren.
// Aeltere Tresore mit anderen Parametern werden beim naechsten Entsperren
// automatisch auf diese Werte hochgezogen (siehe unlock()).
const KDF_M_COST: u32 = 65_536; // 64 MiB
const KDF_T_COST: u32 = 2;
const KDF_P_COST: u32 = 1;
const VAULT_VERSION: u8 = 1;

/// Art eines abgelegten Geheimnisses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Password,
    PrivateKey,
}

/// Oeffentliche Beschreibung eines Eintrags (ohne den geheimen Wert).
#[derive(Debug, Clone, Serialize)]
pub struct SecretMeta {
    pub id: String,
    pub kind: SecretKind,
}

#[derive(Serialize, Deserialize)]
struct Record {
    kind: SecretKind,
    value: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u8,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,  // base64
    nonce: String, // base64
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    header: Header,
    ciphertext: String, // base64
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    data: BTreeMap<String, Record>,
}

/// Gemeinsame Schnittstelle fuer jeden Geheimnis-Speicher (lokal oder spaeter Vaultwarden).
pub trait SecretStore: Send + Sync {
    fn is_unlocked(&self) -> bool;
    fn exists(&self) -> bool;
    fn create(&self, master: &str) -> Result<()>;
    fn unlock(&self, master: &str) -> Result<()>;
    fn lock(&self);
    fn put_secret(&self, id: &str, kind: SecretKind, value: &[u8]) -> Result<()>;
    fn get_secret(&self, id: &str) -> Result<Zeroizing<Vec<u8>>>;
    fn delete_secret(&self, id: &str) -> Result<()>;
    fn list_secrets(&self) -> Result<Vec<SecretMeta>>;
}

/// Dateibasierter lokaler Tresor.
pub struct Vault {
    path: PathBuf,
    state: Mutex<Option<Unlocked>>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(None),
        }
    }

    fn derive_key(master: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        let params = argon2::Params::new(KDF_M_COST, KDF_T_COST, KDF_P_COST, Some(32))
            .map_err(|_| AppError::Crypto)?;
        let argon = argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            params,
        );
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(master.as_bytes(), salt, key.as_mut_slice())
            .map_err(|_| AppError::Crypto)?;
        Ok(key)
    }

    /// Verschluesselt die aktuelle Datenmenge und schreibt die Tresordatei neu
    /// (jedes Mal mit frischer Nonce).
    fn persist(&self, unlocked: &Unlocked) -> Result<()> {
        let plaintext = serde_json::to_vec(&unlocked.data)?;

        let mut nonce_bytes = [0u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);

        let header = Header {
            version: VAULT_VERSION,
            m_cost: KDF_M_COST,
            t_cost: KDF_T_COST,
            p_cost: KDF_P_COST,
            salt: b64().encode(unlocked.salt),
            nonce: b64().encode(nonce_bytes),
        };
        let aad = serde_json::to_vec(&header)?;

        let cipher =
            XChaCha20Poly1305::new_from_slice(unlocked.key.as_slice()).map_err(|_| AppError::Crypto)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::Crypto)?;

        let file = VaultFile {
            header,
            ciphertext: b64().encode(ciphertext),
        };
        let bytes = serde_json::to_vec_pretty(&file)?;
        // Atomar schreiben, damit ein Absturz mitten im Schreiben den Tresor
        // nicht leert oder halb beschreibt (sonst sind alle Geheimnisse weg).
        crate::util::atomic_write(&self.path, &bytes)?;
        Ok(())
    }
}

impl SecretStore for Vault {
    fn is_unlocked(&self) -> bool {
        self.state.lock().unwrap().is_some()
    }

    fn exists(&self) -> bool {
        self.path.exists()
    }

    fn create(&self, master: &str) -> Result<()> {
        if self.exists() {
            return Err(AppError::VaultExists);
        }
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = Vault::derive_key(master, &salt)?;
        let unlocked = Unlocked {
            key,
            salt,
            data: BTreeMap::new(),
        };
        self.persist(&unlocked)?;
        *self.state.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    fn unlock(&self, master: &str) -> Result<()> {
        if !self.exists() {
            return Err(AppError::VaultMissing);
        }
        let raw = std::fs::read(&self.path)?;
        let file: VaultFile = serde_json::from_slice(&raw)?;

        let salt_vec = b64().decode(&file.header.salt).map_err(|_| AppError::Crypto)?;
        let nonce_vec = b64().decode(&file.header.nonce).map_err(|_| AppError::Crypto)?;
        let ct = b64()
            .decode(&file.ciphertext)
            .map_err(|_| AppError::Crypto)?;
        if salt_vec.len() != 16 || nonce_vec.len() != 24 {
            return Err(AppError::Crypto);
        }
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&salt_vec);

        let params = argon2::Params::new(
            file.header.m_cost,
            file.header.t_cost,
            file.header.p_cost,
            Some(32),
        )
        .map_err(|_| AppError::Crypto)?;
        let argon = argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            params,
        );
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(master.as_bytes(), &salt, key.as_mut_slice())
            .map_err(|_| AppError::Crypto)?;

        // Der Header (inkl. KDF-Parameter) ist als AAD gebunden.
        let aad = serde_json::to_vec(&file.header)?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce_vec),
                Payload {
                    msg: &ct,
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::VaultAuth)?;

        let data: BTreeMap<String, Record> = serde_json::from_slice(&plaintext)?;

        let mut unlocked = Unlocked { key, salt, data };

        // Aelteren Tresor transparent auf die aktuellen KDF-Parameter hochziehen,
        // damit das naechste Entsperren schnell ist.
        let outdated = file.header.m_cost != KDF_M_COST
            || file.header.t_cost != KDF_T_COST
            || file.header.p_cost != KDF_P_COST;
        if outdated {
            let mut new_salt = [0u8; 16];
            OsRng.fill_bytes(&mut new_salt);
            unlocked.key = Vault::derive_key(master, &new_salt)?;
            unlocked.salt = new_salt;
            self.persist(&unlocked)?;
        }

        *self.state.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    fn lock(&self) {
        *self.state.lock().unwrap() = None;
    }

    fn put_secret(&self, id: &str, kind: SecretKind, value: &[u8]) -> Result<()> {
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        unlocked.data.insert(
            id.to_string(),
            Record {
                kind,
                value: value.to_vec(),
            },
        );
        self.persist(unlocked)
    }

    fn get_secret(&self, id: &str) -> Result<Zeroizing<Vec<u8>>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        let rec = unlocked
            .data
            .get(id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        Ok(Zeroizing::new(rec.value.clone()))
    }

    fn delete_secret(&self, id: &str) -> Result<()> {
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        unlocked.data.remove(id);
        self.persist(unlocked)
    }

    fn list_secrets(&self) -> Result<Vec<SecretMeta>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(unlocked
            .data
            .iter()
            .map(|(id, rec)| SecretMeta {
                id: id.clone(),
                kind: rec.kind,
            })
            .collect())
    }
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Zufaelliges Token fuer die Absicherung des lokalen MCP-Endpunkts.
pub fn random_token() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Laedt das stabile MCP-Token aus der Datei oder erzeugt und speichert es.
/// Stabil ueber Neustarts, damit die einmalige `claude mcp add`-Registrierung
/// gueltig bleibt. Es ist ein Loopback-Bearer, kein Tresor-Geheimnis.
pub fn load_or_create_token(path: &std::path::Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let token = random_token();
    if let Err(e) = std::fs::write(path, &token) {
        tracing::error!(
            "MCP-Token konnte nicht unter {} gespeichert werden: {e}. Die einmalige \
             `claude mcp add`-Registrierung bleibt nach einem Neustart nicht gueltig.",
            path.display()
        );
    }
    token
}
