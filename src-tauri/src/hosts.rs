use std::path::PathBuf;
use std::sync::Mutex;

use uuid::Uuid;

use crate::error::Result;
use crate::error::AppError;
use crate::model::{AiPolicy, Host, NewHost};
use crate::util::{atomic_write, load_json_vec};

/// Verwaltung der konfigurierten Hosts. Hostdaten sind nicht geheim (Geheimnisse
/// liegen nur als secret_id-Verweis vor) und werden atomar als JSON gespeichert.
pub struct HostStore {
    path: PathBuf,
    hosts: Mutex<Vec<Host>>,
}

impl HostStore {
    pub fn new(path: PathBuf) -> Self {
        let hosts = load_json_vec::<Host>(&path);
        Self {
            path,
            hosts: Mutex::new(hosts),
        }
    }

    fn save(&self, hosts: &[Host]) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(hosts)?;
        atomic_write(&self.path, &bytes)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Host> {
        self.hosts.lock().unwrap().clone()
    }

    pub fn get(&self, id: Uuid) -> Result<Host> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub fn add(&self, new_host: NewHost) -> Result<Host> {
        let host = new_host.into_host();
        let mut hosts = self.hosts.lock().unwrap();
        hosts.push(host.clone());
        self.save(&hosts)?;
        Ok(host)
    }

    pub fn update(&self, host: Host) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let slot = hosts
            .iter_mut()
            .find(|h| h.id == host.id)
            .ok_or_else(|| AppError::NotFound(host.id.to_string()))?;
        *slot = host;
        self.save(&hosts)
    }

    pub fn remove(&self, id: Uuid) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let before = hosts.len();
        hosts.retain(|h| h.id != id);
        if hosts.len() == before {
            return Err(AppError::NotFound(id.to_string()));
        }
        self.save(&hosts)
    }

    pub fn set_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let host = hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        host.ai_policy = policy;
        self.save(&hosts)
    }

    pub fn set_file_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let host = hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        host.ai_file_policy = policy;
        self.save(&hosts)
    }
}
