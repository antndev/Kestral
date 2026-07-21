use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub command: String,
}

pub struct ApprovalBroker {
    app: AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ApprovalBroker {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub async fn request(&self, host_id: String, host_name: String, command: String) -> bool {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let req = ApprovalRequest {
            id: id.clone(),
            host_id,
            host_name,
            command,
        };
        if self.app.emit("approval-request", req).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return false;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                let _ = self.app.emit("approval-expired", &id);
                false
            }
        }
    }

    pub fn resolve(&self, id: &str, approved: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(approved);
        }
    }
}
