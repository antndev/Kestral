
use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key;
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::model::{AuthMethod, Host};
use crate::vault::{SecretStore, Vault};

#[derive(Debug, Clone, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<i32>,
    pub exit_signal: Option<String>,
}

pub struct ClientHandler {
    host: String,
    port: u16,
    key_changed: Arc<std::sync::atomic::AtomicBool>,
    forward_agent: bool,
}

async fn proxy_agent(channel: russh::Channel<client::Msg>) {
    let mut stream = channel.into_stream();
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        match ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent") {
            Ok(mut agent) => {
                if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut agent).await {
                    tracing::debug!("agent forward channel closed: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("no local ssh agent at \\\\.\\pipe\\openssh-ssh-agent: {e}");
            }
        }
    }
    #[cfg(unix)]
    {
        match std::env::var("SSH_AUTH_SOCK") {
            Ok(sock) => match tokio::net::UnixStream::connect(&sock).await {
                Ok(mut agent) => {
                    if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut agent).await {
                        tracing::debug!("agent forward channel closed: {e}");
                    }
                }
                Err(e) => tracing::warn!("cannot connect to SSH_AUTH_SOCK {sock}: {e}"),
            },
            Err(_) => tracing::warn!("agent forwarding requested but SSH_AUTH_SOCK is not set"),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(ssh_key::HashAlg::Sha256);
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                tracing::info!(
                    "TOFU: new host {}:{} accepted, fingerprint {fp}",
                    self.host,
                    self.port
                );
                if let Err(e) = append_known_host(&self.host, self.port, server_public_key) {
                    tracing::warn!("writing known_hosts failed: {e}");
                }
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                tracing::error!(
                    "Host key CHANGED for {}:{} (known_hosts line {line}), fingerprint {fp}, refused",
                    self.host,
                    self.port
                );
                self.key_changed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(false)
            }
            Err(e) => {
                tracing::error!(
                    "checking known_hosts failed for {}:{}: {e}, connection refused",
                    self.host,
                    self.port
                );
                Ok(false)
            }
        }
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        if self.forward_agent {
            tokio::spawn(proxy_agent(channel));
        }
        Ok(())
    }
}

pub struct SshManager {}

impl SshManager {
    pub fn new() -> Self {
        Self {}
    }

    pub async fn connect(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
    ) -> Result<client::Handle<ClientHandler>> {
        self.connect_progress(host, vault, |_| {}).await
    }

    pub async fn connect_progress(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        on_stage: impl Fn(&str),
    ) -> Result<client::Handle<ClientHandler>> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            keepalive_max: 8,
            nodelay: true,
            ..Default::default()
        });

        let key_changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handler = ClientHandler {
            host: host.hostname.clone(),
            port: host.port,
            key_changed: key_changed.clone(),
            forward_agent: host.forward_agent,
        };

        on_stage("connecting");
        let connect_fut = client::connect(config, (host.hostname.as_str(), host.port), handler);
        let mut session =
            match tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut).await {
                Ok(Ok(session)) => session,
                Ok(Err(e)) => {
                    if key_changed.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(AppError::HostKeyChanged(format!(
                            "{}:{}",
                            host.hostname, host.port
                        )));
                    }
                    return Err(AppError::Ssh(format!("Connection failed: {e}")));
                }
                Err(_) => {
                    return Err(AppError::Ssh(
                        "Connection timed out after 15s".into(),
                    ))
                }
            };

        on_stage("authenticating");
        let auth = self.authenticate(&mut session, host, vault).await?;
        if !auth.success() {
            return Err(AppError::Ssh("Authentication rejected".into()));
        }
        Ok(session)
    }

    pub async fn run_command(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        command: &str,
    ) -> Result<CommandOutput> {
        self.run_command_opts(host, vault, command, false).await
    }

    pub async fn run_command_opts(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        command: &str,
        pty: bool,
    ) -> Result<CommandOutput> {
        let session = self.connect(host, vault).await?;

        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("Channel: {e}")))?;
        if host.forward_agent {
            if let Err(e) = channel.agent_forward(true).await {
                tracing::warn!("requesting agent forwarding failed: {e}");
            }
        }
        if pty {
            channel
                .request_pty(true, "xterm-256color", 120, 34, 0, 0, &[])
                .await
                .map_err(|e| AppError::Ssh(format!("PTY: {e}")))?;
        }
        channel
            .exec(true, command)
            .await
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_status: Option<i32> = None;
        let mut exit_signal: Option<String> = None;

        loop {
            let Some(msg) = channel.wait().await else {
                break;
            };
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        stderr.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status: code } => {
                    exit_status = Some(code as i32);
                }
                ChannelMsg::ExitSignal {
                    signal_name,
                    core_dumped,
                    error_message,
                    ..
                } => {
                    let mut s = format!("{signal_name:?}");
                    if core_dumped {
                        s.push_str(" (core dumped)");
                    }
                    if !error_message.is_empty() {
                        s.push_str(&format!(": {error_message}"));
                    }
                    exit_signal = Some(s);
                }
                _ => {}
            }
        }

        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_status,
            exit_signal,
        })
    }

    async fn authenticate(
        &self,
        session: &mut client::Handle<ClientHandler>,
        host: &Host,
        vault: &Arc<Vault>,
    ) -> Result<russh::client::AuthResult> {
        match &host.auth {
            AuthMethod::Password { secret_id } => {
                let bytes = vault.get_secret(secret_id)?;
                let password = zeroize::Zeroizing::new(
                    std::str::from_utf8(&bytes)
                        .map_err(|_| AppError::Ssh("Password is not valid UTF-8".into()))?
                        .to_owned(),
                );
                session
                    .authenticate_password(host.username.clone(), password.as_str())
                    .await
                    .map_err(|e| AppError::Ssh(format!("Auth (password): {e}")))
            }
            AuthMethod::Key { secret_id } => {
                let bytes = vault.get_secret(secret_id)?;
                let key_str = std::str::from_utf8(&bytes)
                    .map_err(|_| AppError::Ssh("Key is not valid UTF-8".into()))?;
                let key = decode_secret_key(key_str, None)
                    .map_err(|e| AppError::Ssh(format!("Load key: {e}")))?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| AppError::Ssh(format!("RSA-Hash: {e}")))?
                    .flatten();
                session
                    .authenticate_publickey(
                        host.username.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| AppError::Ssh(format!("Auth (key): {e}")))
            }
            AuthMethod::Agent => Err(AppError::Ssh(
                "Agent login is not implemented yet (Pageant/Named Pipe on Windows)".into(),
            )),
        }
    }
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}

fn known_hosts_path() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .map(|home| home.join(".ssh").join("known_hosts"))
}

fn append_known_host(host: &str, port: u16, key: &ssh_key::PublicKey) -> std::io::Result<()> {
    use std::io::Write;

    let path = known_hosts_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory")
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let host_entry = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let openssh = key
        .to_openssh()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let line = format!("{host_entry} {openssh}\n");

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
}
