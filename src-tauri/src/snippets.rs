use std::path::PathBuf;
use std::sync::Mutex;

use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{NewSnippet, Snippet};
use crate::util::{atomic_write, load_json_vec};

/// Verwaltung der Snippets (Skripte). Wird atomar als JSON gespeichert.
pub struct SnippetStore {
    path: PathBuf,
    items: Mutex<Vec<Snippet>>,
}

impl SnippetStore {
    pub fn new(path: PathBuf) -> Self {
        let items = load_json_vec::<Snippet>(&path);
        Self {
            path,
            items: Mutex::new(items),
        }
    }

    fn save(&self, items: &[Snippet]) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(items)?;
        atomic_write(&self.path, &bytes)?;
        Ok(())
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

    /// Entfernt einen geloeschten Host aus allen Snippet-Zielen.
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
