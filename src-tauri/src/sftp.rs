//! SFTP über das russh-sftp-Subsystem.
//!
//! Zwei Nutzungswege:
//! - Der Nutzer öffnet im UI einen SFTP-Browser. Dafür hält [`SftpSessions`] pro
//!   geöffnetem Tab eine dauerhafte Verbindung (schnelles Navigieren).
//! - Die KI ruft über MCP einzelne Übertragungen ab. Das läuft als One-Shot
//!   (verbinden, Aktion, trennen) durch das Gate (eigene Datei-Policy je Host,
//!   ggf. Freigabe) und wird protokolliert. Private Schlüssel verlassen den Kern
//!   wie immer nie.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, Result};
use crate::model::Host;
use crate::ssh::{ClientHandler, SshManager};
use crate::vault::Vault;

/// Ein Eintrag in einem Remote-Verzeichnis (ohne sensible Daten).
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Letzte Änderung als Unix-Sekunden, falls der Server sie liefert.
    pub mtime: Option<i64>,
    /// POSIX-Rechtebits, falls vorhanden.
    pub permissions: Option<u32>,
}

fn ferr<E: std::fmt::Display>(ctx: &str, e: E) -> AppError {
    AppError::Ssh(format!("SFTP {ctx}: {e}"))
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Öffnet das SFTP-Subsystem auf einer bestehenden SSH-Sitzung.
async fn open_subsystem(session: &client::Handle<ClientHandler>) -> Result<SftpSession> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| ferr("Kanal", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| ferr("Subsystem", e))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| ferr("Init", e))
}

async fn list(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>> {
    let dir = sftp.read_dir(path).await.map_err(|e| ferr("read_dir", e))?;
    let mut out = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        out.push(FileEntry {
            path: join(path, &name),
            name,
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map(|m| m as i64),
            permissions: meta.permissions,
        });
    }
    // Verzeichnisse zuerst, dann alphabetisch (case-insensitive).
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

async fn download(sftp: &SftpSession, remote: &str, local: &Path) -> Result<u64> {
    let mut rf = sftp.open(remote).await.map_err(|e| ferr("open", e))?;
    let mut buf = Vec::new();
    rf.read_to_end(&mut buf).await.map_err(|e| ferr("read", e))?;
    let n = buf.len() as u64;
    tokio::fs::write(local, &buf)
        .await
        .map_err(|e| ferr("lokal schreiben", e))?;
    Ok(n)
}

async fn upload(sftp: &SftpSession, local: &Path, remote: &str) -> Result<u64> {
    let buf = tokio::fs::read(local)
        .await
        .map_err(|e| ferr("lokal lesen", e))?;
    let mut wf = sftp.create(remote).await.map_err(|e| ferr("create", e))?;
    wf.write_all(&buf).await.map_err(|e| ferr("write", e))?;
    wf.flush().await.ok();
    wf.shutdown().await.ok();
    Ok(buf.len() as u64)
}

/// Eine offene SFTP-Verbindung. Hält die SSH-Sitzung am Leben, solange der
/// Browser-Tab offen ist.
pub struct SftpHandle {
    _conn: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

impl SftpHandle {
    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        list(&self.sftp, path).await
    }
    pub async fn home(&self) -> Result<String> {
        self.sftp
            .canonicalize(".")
            .await
            .map_err(|e| ferr("home", e))
    }
    pub async fn download(&self, remote: &str, local: &Path) -> Result<u64> {
        download(&self.sftp, remote, local).await
    }
    pub async fn upload(&self, local: &Path, remote: &str) -> Result<u64> {
        upload(&self.sftp, local, remote).await
    }
    /// Liest eine Remote-Textdatei als UTF-8 (fuer den eingebauten Editor).
    pub async fn read_text(&self, path: &str) -> Result<String> {
        let mut f = self.sftp.open(path).await.map_err(|e| ferr("open", e))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).await.map_err(|e| ferr("read", e))?;
        String::from_utf8(buf).map_err(|_| AppError::Ssh("Keine UTF-8-Textdatei".into()))
    }
    /// Schreibt Textinhalt zurueck in die Remote-Datei.
    pub async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        let mut f = self.sftp.create(path).await.map_err(|e| ferr("create", e))?;
        f.write_all(content.as_bytes()).await.map_err(|e| ferr("write", e))?;
        f.flush().await.ok();
        f.shutdown().await.ok();
        Ok(())
    }
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.sftp.create_dir(path).await.map_err(|e| ferr("mkdir", e))
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.sftp
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| ferr("rename", e))
    }
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir {
            self.sftp
                .remove_dir(path)
                .await
                .map_err(|e| ferr("remove_dir", e))
        } else {
            self.sftp
                .remove_file(path)
                .await
                .map_err(|e| ferr("remove_file", e))
        }
    }
}

/// Baut eine neue SFTP-Verbindung zu einem Host auf.
pub async fn connect(ssh: &SshManager, vault: &Arc<Vault>, host: &Host) -> Result<SftpHandle> {
    let conn = ssh.connect(host, vault).await?;
    let sftp = open_subsystem(&conn).await?;
    Ok(SftpHandle { _conn: conn, sftp })
}

// --- One-Shot-Helfer für die KI (verbinden, Aktion, trennen) ---

pub async fn one_shot_list(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    path: &str,
) -> Result<Vec<FileEntry>> {
    connect(ssh, vault, host).await?.list(path).await
}

pub async fn one_shot_download(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    remote: &str,
    local: &Path,
) -> Result<u64> {
    connect(ssh, vault, host).await?.download(remote, local).await
}

pub async fn one_shot_upload(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    local: &Path,
    remote: &str,
) -> Result<u64> {
    connect(ssh, vault, host).await?.upload(local, remote).await
}

/// Vom UI gehaltene SFTP-Browser-Sitzungen, adressiert per id.
#[derive(Default)]
pub struct SftpSessions(Mutex<HashMap<String, Arc<SftpHandle>>>);

impl SftpSessions {
    pub fn get(&self, id: &str) -> Option<Arc<SftpHandle>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    pub fn insert(&self, id: String, handle: Arc<SftpHandle>) {
        self.0.lock().unwrap().insert(id, handle);
    }
    pub fn remove(&self, id: &str) -> Option<Arc<SftpHandle>> {
        self.0.lock().unwrap().remove(id)
    }
}
