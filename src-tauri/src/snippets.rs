use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{NewSnippet, Snippet};
use crate::vault::Vault;

pub struct SnippetStore {
    path: PathBuf,
    vault: Arc<Vault>,
    warning: Mutex<Option<String>>,
    items: Mutex<Vec<Snippet>>,
}

impl SnippetStore {
    pub fn new(path: PathBuf, vault: Arc<Vault>) -> Self {
        Self {
            path,
            vault,
            warning: Mutex::new(None),
            items: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self) -> Result<()> {
        if let Some(bytes) = self.vault.get_blob(Vault::snippets_blob_id())? {
            match serde_json::from_slice::<Vec<Snippet>>(&bytes) {
                Ok(items) => {
                    *self.warning.lock().unwrap() = None;
                    *self.items.lock().unwrap() = items;
                }
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Scripts in the vault could not be read ({e}). Nothing was changed."
                    ));
                    *self.items.lock().unwrap() = Vec::new();
                }
            }
            return Ok(());
        }

        let had_file = self.path.exists();
        let items = match std::fs::read(&self.path) {
            Ok(raw) => self.decode_legacy(&raw)?,
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        *self.warning.lock().unwrap() = None;
        *self.items.lock().unwrap() = items.clone();

        if had_file {
            self.save(&items)?;
            let bak = self.path.with_extension("json.migrated.bak");
            let _ = std::fs::rename(&self.path, &bak);
            tracing::info!(
                "snippets in den Tresor uebernommen, alte Datei liegt als {}",
                bak.display()
            );
        }
        Ok(())
    }

    fn decode_legacy(&self, raw: &[u8]) -> Result<Vec<Snippet>> {
        match raw.iter().find(|b| !b.is_ascii_whitespace()).copied() {
            Some(b'[') => Ok(serde_json::from_slice(raw).unwrap_or_default()),
            Some(b'{') => match self.vault.open_envelope(raw) {
                Ok((plain, _)) => Ok(serde_json::from_slice(&plain)?),
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Scripts could not be decrypted ({e}). The old file is left untouched."
                    ));
                    tracing::error!("items nicht entschluesselbar ({e}), starte leer");
                    Ok(Vec::new())
                }
            },
            _ => Ok(Vec::new()),
        }
    }

    pub fn warning(&self) -> Option<String> {
        self.warning.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        *self.items.lock().unwrap() = Vec::new();
    }

    fn save(&self, items: &[Snippet]) -> Result<()> {
        let bytes = serde_json::to_vec(items)?;
        self.vault.put_blob(Vault::snippets_blob_id(), &bytes)
    }

    pub fn list(&self) -> Vec<Snippet> {
        self.items.lock().unwrap().clone()
    }

    pub fn add(&self, new: NewSnippet) -> Result<Snippet> {
        let snippet = new.into_snippet();
        let mut items = self.items.lock().unwrap();
        items.push(snippet.clone());
        self.save(&items)?;
        Ok(snippet)
    }

    pub fn update(&self, snippet: Snippet) -> Result<()> {
        let mut items = self.items.lock().unwrap();
        let slot = items
            .iter_mut()
            .find(|s| s.id == snippet.id)
            .ok_or_else(|| AppError::NotFound(snippet.id.to_string()))?;
        *slot = snippet;
        self.save(&items)
    }

    pub fn remove_host(&self, host_id: Uuid) -> Result<()> {
        let mut items = self.items.lock().unwrap();
        let mut changed = false;
        for s in items.iter_mut() {
            let before = s.target_host_ids.len();
            s.target_host_ids.retain(|h| *h != host_id);
            if s.target_host_ids.len() != before {
                changed = true;
            }
        }
        if changed {
            self.save(&items)?;
        }
        Ok(())
    }

    pub fn remove(&self, id: Uuid) -> Result<()> {
        let mut items = self.items.lock().unwrap();
        let before = items.len();
        items.retain(|s| s.id != id);
        if items.len() == before {
            return Err(AppError::NotFound(id.to_string()));
        }
        self.save(&items)
    }
}
