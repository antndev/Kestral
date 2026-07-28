// Local port forwarding (like `ssh -L`). Kestral binds a loopback port and
// tunnels every connection through a direct-tcpip channel on the host's SSH
// session, so a service that only listens locally on the remote (a web UI on
// 127.0.0.1, say) becomes reachable in the local browser. Each active forward
// keeps its own SSH session alive until it is stopped.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::client;
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{Host, PortForward};
use crate::ssh::{ClientHandler, SshManager};
use crate::vault::Vault;

struct Active {
    task: tokio::task::JoinHandle<()>,
    session: Arc<client::Handle<ClientHandler>>,
}

#[derive(Default)]
pub struct ForwardManager {
    active: Mutex<HashMap<(Uuid, Uuid), Active>>,
}

impl ForwardManager {
    pub fn is_active(&self, host_id: Uuid, forward_id: Uuid) -> bool {
        self.active
            .lock()
            .unwrap()
            .contains_key(&(host_id, forward_id))
    }

    /// IDs of every forward that is currently open.
    pub fn active_ids(&self) -> Vec<Uuid> {
        self.active
            .lock()
            .unwrap()
            .keys()
            .map(|(_, f)| *f)
            .collect()
    }

    pub async fn start(
        &self,
        ssh: &SshManager,
        host: &Host,
        vault: &Arc<Vault>,
        fwd: &PortForward,
    ) -> Result<()> {
        if self.is_active(host.id, fwd.id) {
            return Ok(());
        }

        // Bind the local port before connecting, so a port clash fails fast
        // without leaving an SSH session behind.
        let listener = TcpListener::bind(("127.0.0.1", fwd.local_port))
            .await
            .map_err(|e| {
                AppError::Ssh(format!("local port {} is not available: {e}", fwd.local_port))
            })?;

        let session = Arc::new(ssh.connect(host, vault).await?);

        let loop_session = session.clone();
        let remote_host = fwd.remote_host.clone();
        let remote_port = fwd.remote_port;
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, peer) = match listener.accept().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::debug!("forward listener stopped: {e}");
                        break;
                    }
                };
                let session = loop_session.clone();
                let rhost = remote_host.clone();
                tokio::spawn(async move {
                    let channel = match session
                        .channel_open_direct_tcpip(
                            rhost,
                            remote_port as u32,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!("opening forward channel failed: {e}");
                            return;
                        }
                    };
                    let mut stream = channel.into_stream();
                    if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut stream).await {
                        tracing::debug!("forward connection closed: {e}");
                    }
                });
            }
        });

        self.active
            .lock()
            .unwrap()
            .insert((host.id, fwd.id), Active { task, session });
        Ok(())
    }

    pub async fn stop(&self, host_id: Uuid, forward_id: Uuid) {
        let removed = self.active.lock().unwrap().remove(&(host_id, forward_id));
        if let Some(a) = removed {
            a.task.abort();
            let _ = a
                .session
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
        }
    }
}
