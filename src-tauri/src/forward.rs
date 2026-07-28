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
    // A present key means the forward is running or in the middle of starting.
    // `None` is a reservation held while start() binds and connects, so a second
    // start (autostart racing a click, a double tap) sees it and backs off
    // instead of trying to bind the same port twice.
    active: Mutex<HashMap<(Uuid, Uuid), Option<Active>>>,
}

impl ForwardManager {
    /// IDs of every forward that is running or starting.
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
        let key = (host.id, fwd.id);

        // Reserve the slot atomically. If it is already taken, this start is a
        // no-op, which is exactly what a duplicate request should do.
        {
            let mut map = self.active.lock().unwrap();
            if map.contains_key(&key) {
                return Ok(());
            }
            map.insert(key, None);
        }

        match self.spawn(ssh, host, vault, fwd, key).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Bind or connect failed: drop the reservation so a retry works.
                self.active.lock().unwrap().remove(&key);
                Err(e)
            }
        }
    }

    async fn spawn(
        &self,
        ssh: &SshManager,
        host: &Host,
        vault: &Arc<Vault>,
        fwd: &PortForward,
        key: (Uuid, Uuid),
    ) -> Result<()> {
        let bind_host = {
            let h = fwd.local_host.trim();
            if h.is_empty() {
                "127.0.0.1"
            } else {
                h
            }
        };
        let listener = TcpListener::bind((bind_host, fwd.local_port))
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    AppError::Ssh(format!(
                        "{bind_host}:{} is already in use. Close whatever is using it, or pick a different local port.",
                        fwd.local_port
                    ))
                } else {
                    AppError::Ssh(format!(
                        "cannot bind {bind_host}:{}: {e}",
                        fwd.local_port
                    ))
                }
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

        // Publish the running forward, unless it was stopped while we were
        // starting up. In that case tear the fresh listener and session down.
        let active = Active { task, session };
        let orphan = {
            let mut map = self.active.lock().unwrap();
            match map.get_mut(&key) {
                Some(slot) => {
                    *slot = Some(active);
                    None
                }
                None => Some(active),
            }
        };
        if let Some(a) = orphan {
            a.task.abort();
            let _ = a.task.await;
            let _ = a
                .session
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
        }
        Ok(())
    }

    pub async fn stop(&self, host_id: Uuid, forward_id: Uuid) {
        let removed = self.active.lock().unwrap().remove(&(host_id, forward_id));
        // Some(Some(_)): running, tear it down. Some(None): still starting, and
        // removing the reservation tells spawn() to clean up after itself.
        if let Some(Some(a)) = removed {
            a.task.abort();
            // Wait for the accept loop to finish so its listener is dropped and
            // the local port is free before we return; otherwise an immediate
            // restart could hit "address already in use".
            let _ = a.task.await;
            let _ = a
                .session
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await;
        }
    }
}
