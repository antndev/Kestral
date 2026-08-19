use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// App-level preferences the Rust side needs to know about (the window-close
// behaviour) or that gate first-run onboarding. Kept tiny and separate from the
// vault so it can be read before unlock.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub minimize_to_tray: bool,
    pub onboarded: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    // Mirrored as an atomic so the window-close handler can read it without a
    // lock on the UI thread.
    pub minimize_to_tray: AtomicBool,
    // Set when the user picks Exit from the tray, so the next close really quits
    // instead of hiding to the tray again.
    pub quitting: AtomicBool,
    inner: Mutex<AppSettings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let settings: AppSettings = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            minimize_to_tray: AtomicBool::new(settings.minimize_to_tray),
            quitting: AtomicBool::new(false),
            inner: Mutex::new(settings),
            path,
        }
    }

    fn persist(&self) {
        if let Ok(s) = self.inner.lock() {
            if let Ok(bytes) = serde_json::to_vec_pretty(&*s) {
                let _ = std::fs::write(&self.path, bytes);
            }
        }
    }

    pub fn get(&self) -> AppSettings {
        self.inner.lock().unwrap().clone()
    }

    pub fn set_minimize_to_tray(&self, enabled: bool) {
        self.minimize_to_tray.store(enabled, Ordering::SeqCst);
        if let Ok(mut s) = self.inner.lock() {
            s.minimize_to_tray = enabled;
        }
        self.persist();
    }

    pub fn set_onboarded(&self) {
        if let Ok(mut s) = self.inner.lock() {
            s.onboarded = true;
        }
        self.persist();
    }
}
