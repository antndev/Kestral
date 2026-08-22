use std::collections::HashSet;

use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::model::{Host, Snippet};
use crate::state::Services;
use crate::vault::{SecretKind, SecretStore};

const BUNDLE_VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
struct ExportedSecret {
    id: String,
    kind: SecretKind,
    value: String,
}

#[derive(Serialize, Deserialize)]
struct Bundle {
    version: u8,
    secrets: Vec<ExportedSecret>,
    hosts: Vec<Host>,
    snippets: Vec<Snippet>,
}

#[derive(Serialize)]
pub struct ImportReport {
    pub hosts_added: usize,
    pub hosts_skipped: usize,
    pub secrets_added: usize,
    pub secrets_skipped: usize,
    pub snippets_added: usize,
    pub snippets_skipped: usize,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Gather every host, snippet and secret from the unlocked vault into one bundle
/// and encrypt it under a standalone password (independent of the vault's own).
/// The result is a portable file the user can carry to another machine.
pub fn export(services: &Services, password: &str) -> Result<Vec<u8>> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let mut secrets = Vec::new();
    for meta in services.vault.list_secrets()? {
        let value = services.vault.get_secret(&meta.id)?;
        secrets.push(ExportedSecret {
            id: meta.id,
            kind: meta.kind,
            value: b64().encode(value.as_slice()),
        });
    }

    let bundle = Bundle {
        version: BUNDLE_VERSION,
        secrets,
        hosts: services.hosts.list(),
        snippets: services.snippets.list(),
    };

    let plaintext = Zeroizing::new(serde_json::to_vec(&bundle)?);
    crate::vault::seal_with_password(&plaintext, password)
}

/// Decrypt a bundle and merge it into the unlocked target vault. The merge is
/// additive and non-destructive: entries whose id (or, for hosts, name) already
/// exists are skipped, so re-importing is safe. Everything ends up sealed under
/// the target vault's own password.
pub fn import(services: &Services, file_bytes: &[u8], password: &str) -> Result<ImportReport> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let plaintext = crate::vault::open_with_password(file_bytes, password)?;
    let bundle: Bundle = serde_json::from_slice(&plaintext)?;
    if bundle.version != BUNDLE_VERSION {
        return Err(AppError::Other(format!(
            "this export was written by a different Kestral version (format {})",
            bundle.version
        )));
    }

    let existing: HashSet<String> = services
        .vault
        .list_secrets()?
        .into_iter()
        .map(|m| m.id)
        .collect();

    let mut secrets_added = 0;
    let mut secrets_skipped = 0;
    for s in &bundle.secrets {
        if existing.contains(&s.id) {
            secrets_skipped += 1;
            continue;
        }
        let raw = Zeroizing::new(b64().decode(&s.value).map_err(|_| AppError::Crypto)?);
        services.vault.put_secret(&s.id, s.kind, raw.as_slice())?;
        secrets_added += 1;
    }

    let (hosts_added, hosts_skipped) = services.hosts.import(bundle.hosts)?;
    let (snippets_added, snippets_skipped) = services.snippets.import(bundle.snippets)?;

    Ok(ImportReport {
        hosts_added,
        hosts_skipped,
        secrets_added,
        secrets_skipped,
        snippets_added,
        snippets_skipped,
    })
}
