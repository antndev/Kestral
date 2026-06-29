//! Interaktive SSH-Terminal-Sitzungen (echte PTY-Shell).
//!
//! Pro Sitzung wird ein russh-Kanal geoeffnet, eine PTY und eine Shell
//! angefordert und dann gesplittet: ein Reader-Task schiebt die Ausgabe als
//! Roh-Bytes ueber einen Tauri-Channel ans Frontend (xterm), die Schreibseite
//! liegt unter einer id im State und wird von ssh_write/ssh_resize genutzt.
//! Endet die Gegenstelle, raeumt der Reader sich selbst auf und meldet
//! "session-closed" ans Frontend.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::{client, ChannelMsg};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::ssh::ClientHandler;
use crate::state::AppState;

/// Verbindungs-Phase einer Terminal-Sitzung (fuer das UI, wie bei Termius).
/// stage: connecting | authenticating | opening-shell | connected | error
#[derive(Serialize, Clone)]
struct SessionStatus<'a> {
    id: &'a str,
    stage: &'a str,
    detail: &'a str,
}

type Session = client::Handle<ClientHandler>;
type WriteHalf = russh::ChannelWriteHalf<client::Msg>;
type SessionMap = Arc<Mutex<HashMap<String, SessionHandle>>>;

struct SessionHandle {
    write: Arc<AsyncMutex<WriteHalf>>,
    session: Session,
    // Wird erst NACH dem Registrieren des Eintrags nachgetragen, daher Option.
    reader: Option<tokio::task::JoinHandle<()>>,
}

/// Von Tauri verwaltete Terminal-Sitzungen, adressiert per id.
#[derive(Default)]
pub struct Sessions(SessionMap);

/// Sitzung sauber beenden: Kanal schliessen, Verbindung trennen, Reader abbrechen.
async fn teardown(h: SessionHandle) {
    {
        let w = h.write.lock().await;
        let _ = w.eof().await;
        let _ = w.close().await;
    }
    let _ = h
        .session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    if let Some(reader) = h.reader {
        reader.abort();
    }
}

/// Tote Sitzung (Schreibfehler) entfernen, beenden und das UI informieren.
async fn close_dead(app: &tauri::AppHandle, sessions: &Sessions, id: &str) {
    let removed = { sessions.0.lock().unwrap().remove(id) };
    if let Some(h) = removed {
        teardown(h).await;
    }
    let _ = app.emit("session-closed", id);
}

#[tauri::command]
pub async fn ssh_open_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sessions: State<'_, Sessions>,
    id: String,
    host_id: String,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
) -> Result<()> {
    // Falls die id bereits belegt ist, alte Sitzung sauber beenden (kein Leak).
    let prev = { sessions.0.lock().unwrap().remove(&id) };
    if let Some(h) = prev {
        teardown(h).await;
    }

    let hid = Uuid::parse_str(&host_id).map_err(|_| AppError::NotFound(host_id.clone()))?;
    let host = state.services.hosts.get(hid)?;

    // Phasen ans UI melden (wie bei Termius sieht man, wo es gerade haengt).
    let notify = |stage: &str, detail: &str| {
        let _ = app.emit(
            "session-status",
            SessionStatus {
                id: &id,
                stage,
                detail,
            },
        );
    };

    let host_addr = format!("{}:{}", host.hostname, host.port);
    let session = match state
        .services
        .ssh
        .connect_progress(&host, &state.services.vault, |stage| {
            notify(stage, if stage == "connecting" { &host_addr } else { "" });
        })
        .await
    {
        Ok(s) => s,
        Err(e) => {
            notify("error", &e.to_string());
            return Err(e);
        }
    };

    notify("opening-shell", "");
    let channel = match session.channel_open_session().await {
        Ok(c) => c,
        Err(e) => {
            let err = AppError::Ssh(format!("Kanal: {e}"));
            notify("error", &err.to_string());
            return Err(err);
        }
    };
    if let Err(e) = channel
        .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
        .await
    {
        let err = AppError::Ssh(format!("PTY: {e}"));
        notify("error", &err.to_string());
        return Err(err);
    }
    if let Err(e) = channel.request_shell(true).await {
        let err = AppError::Ssh(format!("Shell: {e}"));
        notify("error", &err.to_string());
        return Err(err);
    }
    notify("connected", "");

    let (mut read_half, write_half) = channel.split();

    // Eintrag ZUERST registrieren (reader noch leer), damit die Selbst-
    // Aufraeumung des Readers ihn garantiert findet und kein toter Eintrag
    // entsteht, falls die Gegenstelle sofort schliesst. Einen evtl. waehrend
    // des Verbindens fuer dieselbe id eingefuegten Eintrag sauber beenden.
    let displaced = {
        sessions.0.lock().unwrap().insert(
            id.clone(),
            SessionHandle {
                write: Arc::new(AsyncMutex::new(write_half)),
                session,
                reader: None,
            },
        )
    };
    if let Some(h) = displaced {
        teardown(h).await;
    }

    // Reader-Task: Ausgabe streamen; raeumt sich am Ende selbst auf.
    let map = sessions.0.clone();
    let task_id = id.clone();
    let app_for_reader = app.clone();
    let reader = tokio::spawn(async move {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                }
                ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        // Gegenstelle hat geschlossen: eigenen Eintrag entfernen und UI informieren.
        let removed = { map.lock().unwrap().remove(&task_id) };
        drop(removed);
        let _ = app_for_reader.emit("session-closed", &task_id);
    });

    // Reader-Handle in den (evtl. schon wieder entfernten) Eintrag nachtragen.
    {
        let mut map = sessions.0.lock().unwrap();
        match map.get_mut(&id) {
            Some(h) => h.reader = Some(reader),
            // Reader war schneller und hat sich bereits selbst entfernt.
            None => reader.abort(),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    app: tauri::AppHandle,
    sessions: State<'_, Sessions>,
    id: String,
    data: String,
) -> Result<()> {
    let writer = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.write.clone())
    };
    if let Some(writer) = writer {
        let bytes = data.into_bytes();
        if writer.lock().await.data(&bytes[..]).await.is_err() {
            close_dead(&app, &sessions, &id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    app: tauri::AppHandle,
    sessions: State<'_, Sessions>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let writer = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.write.clone())
    };
    if let Some(writer) = writer {
        if writer
            .lock()
            .await
            .window_change(cols.max(1), rows.max(1), 0, 0)
            .await
            .is_err()
        {
            close_dead(&app, &sessions, &id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(sessions: State<'_, Sessions>, id: String) -> Result<()> {
    let removed = { sessions.0.lock().unwrap().remove(&id) };
    if let Some(h) = removed {
        teardown(h).await;
    }
    Ok(())
}
