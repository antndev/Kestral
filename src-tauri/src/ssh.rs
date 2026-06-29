//! SSH-Ausfuehrung ueber russh.
//!
//! Der private Schluessel kommt nur kurz aus dem Tresor, wird in diesem Prozess
//! geladen und signiert die Authentifizierung intern. Er verlaesst den Kern nie
//! und wird der KI niemals gezeigt.

use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key;
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;

use crate::error::{AppError, Result};
use crate::model::{AuthMethod, Host};
use crate::vault::{SecretStore, Vault};

/// Ergebnis eines Remote-Befehls.
#[derive(Debug, Clone, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<i32>,
    /// Gesetzt, wenn der Befehl durch ein Signal beendet wurde (statt Exitcode).
    pub exit_signal: Option<String>,
}

/// Handler fuer eine SSH-Sitzung. Haelt host/port fuer die known_hosts-Pruefung.
pub struct ClientHandler {
    host: String,
    port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            // Bekannt und passt.
            Ok(true) => Ok(true),
            // Unbekannt: Trust on first use, merken und akzeptieren.
            // ABER: russh liefert auch fuer eine vorhandene, aber UNLESBARE
            // known_hosts-Datei Ok(false) (interne File::open-Fehler werden zu
            // einer leeren Liste verschluckt). Wuerden wir das blind als
            // "erstmalig" behandeln, liesse sich die Changed-Key-/MITM-Pruefung
            // durch Sperren der Datei aushebeln. Daher: existiert die Datei, ist
            // aber nicht lesbar, fail closed. Nur eine echt fehlende Datei loest
            // TOFU aus.
            Ok(false) => {
                if let Some(path) = known_hosts_path() {
                    if path.exists() {
                        if let Err(e) = std::fs::File::open(&path) {
                            tracing::error!(
                                "known_hosts vorhanden, aber nicht lesbar: {e}, Verbindung abgelehnt"
                            );
                            return Ok(false);
                        }
                    }
                }
                if let Err(e) = append_known_host(&self.host, self.port, server_public_key) {
                    tracing::warn!("known_hosts schreiben fehlgeschlagen: {e}");
                }
                Ok(true)
            }
            // Host bekannt, aber Key geaendert: hart ablehnen (moeglicher MITM).
            Err(russh::keys::Error::KeyChanged { line }) => {
                tracing::error!("Host-Key geaendert (known_hosts Zeile {line}), abgelehnt");
                Ok(false)
            }
            // Pruefung fehlgeschlagen (korrupte known_hosts-Zeile, IO-/Rechtefehler,
            // kein Home-Verzeichnis). Fail closed: ablehnen statt blind vertrauen,
            // sonst liesse sich die Changed-Key-Pruefung umgehen. Eine FEHLENDE Datei
            // liefert bereits Ok(false) (TOFU-Zweig oben), nicht Err.
            Err(e) => {
                tracing::error!("known_hosts pruefen fehlgeschlagen: {e}, Verbindung abgelehnt");
                Ok(false)
            }
        }
    }
}

/// Baut SSH-Verbindungen auf und fuehrt Befehle aus.
pub struct SshManager {}

impl SshManager {
    pub fn new() -> Self {
        Self {}
    }

    /// Baut eine Verbindung auf und authentifiziert sie. Gibt die offene Session
    /// zurueck. Wird vom Terminal (interaktive Shell) und von run_command geteilt.
    pub async fn connect(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
    ) -> Result<client::Handle<ClientHandler>> {
        self.connect_progress(host, vault, |_| {}).await
    }

    /// Wie `connect`, meldet aber jede Phase (connecting, authenticating) ueber
    /// `on_stage`, damit das UI wie bei Termius zeigen kann, wo es gerade haengt.
    pub async fn connect_progress(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        on_stage: impl Fn(&str),
    ) -> Result<client::Handle<ClientHandler>> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            ..Default::default()
        });

        let handler = ClientHandler {
            host: host.hostname.clone(),
            port: host.port,
        };

        on_stage("connecting");
        let connect_fut = client::connect(config, (host.hostname.as_str(), host.port), handler);
        let mut session =
            match tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut).await {
                Ok(result) => {
                    result.map_err(|e| AppError::Ssh(format!("Verbindung fehlgeschlagen: {e}")))?
                }
                Err(_) => {
                    return Err(AppError::Ssh(
                        "Verbindung: Zeitueberschreitung nach 15s".into(),
                    ))
                }
            };

        on_stage("authenticating");
        let auth = self.authenticate(&mut session, host, vault).await?;
        if !auth.success() {
            return Err(AppError::Ssh("Authentifizierung abgelehnt".into()));
        }
        Ok(session)
    }

    pub async fn run_command(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        command: &str,
    ) -> Result<CommandOutput> {
        let session = self.connect(host, vault).await?;

        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("Kanal: {e}")))?;
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
                // Klartext-Passwort in einem zeroizing-String halten (wird beim Drop
                // genullt). russh kopiert es intern leider in einen eigenen String.
                let password = zeroize::Zeroizing::new(
                    std::str::from_utf8(&bytes)
                        .map_err(|_| AppError::Ssh("Passwort ist kein gueltiges UTF-8".into()))?
                        .to_owned(),
                );
                session
                    .authenticate_password(host.username.clone(), password.as_str())
                    .await
                    .map_err(|e| AppError::Ssh(format!("Auth (Passwort): {e}")))
            }
            AuthMethod::Key { secret_id } => {
                let bytes = vault.get_secret(secret_id)?;
                let key_str = std::str::from_utf8(&bytes)
                    .map_err(|_| AppError::Ssh("Schluessel ist kein gueltiges UTF-8".into()))?;
                let key = decode_secret_key(key_str, None)
                    .map_err(|e| AppError::Ssh(format!("Schluessel laden: {e}")))?;
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
                    .map_err(|e| AppError::Ssh(format!("Auth (Schluessel): {e}")))
            }
            AuthMethod::Agent => Err(AppError::Ssh(
                "Agent-Login folgt spaeter (unter Windows Pageant/Named Pipe)".into(),
            )),
        }
    }
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Pfad zur known_hosts-Datei (USERPROFILE/HOME + .ssh/known_hosts).
fn known_hosts_path() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .map(|home| home.join(".ssh").join("known_hosts"))
}

/// Haengt einen Host-Key an die known_hosts-Datei an (Trust on first use).
fn append_known_host(host: &str, port: u16, key: &ssh_key::PublicKey) -> std::io::Result<()> {
    use std::io::Write;

    let path = known_hosts_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "kein Home-Verzeichnis")
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
