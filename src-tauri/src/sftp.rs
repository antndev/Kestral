
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

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<i64>,
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

fn is_safe_component(name: &str) -> bool {
    let mut comps = Path::new(name).components();
    matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

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
        .map_err(|e| ferr("write local file", e))?;
    Ok(n)
}

fn download_dir(
    sftp: &SftpSession,
    remote: String,
    local: std::path::PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + '_>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(&local)
            .await
            .map_err(|e| ferr("create local dir", e))?;
        let entries = list(sftp, &remote).await?;
        let mut total = 0u64;
        for e in entries {
            if e.is_symlink {
                continue;
            }
            if !is_safe_component(&e.name) {
                continue;
            }
            let child = local.join(&e.name);
            if e.is_dir {
                total += download_dir(sftp, e.path, child).await?;
            } else {
                total += download(sftp, &e.path, &child).await?;
            }
        }
        Ok(total)
    })
}

async fn upload(sftp: &SftpSession, local: &Path, remote: &str) -> Result<u64> {
    let buf = tokio::fs::read(local)
        .await
        .map_err(|e| ferr("read local file", e))?;
    let mut wf = sftp.create(remote).await.map_err(|e| ferr("create", e))?;
    wf.write_all(&buf).await.map_err(|e| ferr("write", e))?;
    wf.flush().await.map_err(|e| ferr("flush", e))?;
    wf.shutdown().await.map_err(|e| ferr("close", e))?;
    Ok(buf.len() as u64)
}

fn upload_dir(
    sftp: &SftpSession,
    local: std::path::PathBuf,
    remote: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + '_>> {
    Box::pin(async move {
        let _ = sftp.create_dir(&remote).await;
        let mut rd = tokio::fs::read_dir(&local)
            .await
            .map_err(|e| ferr("read local dir", e))?;
        let mut total = 0u64;
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| ferr("read local dir", e))?
        {
            let ft = entry.file_type().await.map_err(|e| ferr("local type", e))?;
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            let child_remote = join(&remote, &name);
            if ft.is_dir() {
                total += upload_dir(sftp, entry.path(), child_remote).await?;
            } else if ft.is_file() {
                total += upload(sftp, &entry.path(), &child_remote).await?;
            }
        }
        Ok(total)
    })
}

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
    pub async fn download_dir(&self, remote: &str, local: &Path) -> Result<u64> {
        download_dir(&self.sftp, remote.to_string(), local.to_path_buf()).await
    }
    pub async fn upload(&self, local: &Path, remote: &str) -> Result<u64> {
        upload(&self.sftp, local, remote).await
    }
    pub async fn upload_dir(&self, local: &Path, remote: &str) -> Result<u64> {
        upload_dir(&self.sftp, local.to_path_buf(), remote.to_string()).await
    }
    pub async fn read_text(&self, path: &str) -> Result<String> {
        let mut f = self.sftp.open(path).await.map_err(|e| ferr("open", e))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).await.map_err(|e| ferr("read", e))?;
        String::from_utf8(buf).map_err(|_| AppError::Ssh("Not a UTF-8 text file".into()))
    }
    pub async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        let mut f = self.sftp.create(path).await.map_err(|e| ferr("create", e))?;
        f.write_all(content.as_bytes()).await.map_err(|e| ferr("write", e))?;
        f.flush().await.map_err(|e| ferr("flush", e))?;
        f.shutdown().await.map_err(|e| ferr("close", e))?;
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

pub async fn connect(ssh: &SshManager, vault: &Arc<Vault>, host: &Host) -> Result<SftpHandle> {
    let conn = ssh.connect(host, vault).await?;
    let sftp = open_subsystem(&conn).await?;
    Ok(SftpHandle { _conn: conn, sftp })
}

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
