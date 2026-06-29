//! Kleine Hilfsfunktionen fuer dauerhaftes, sicheres Speichern.

use std::path::Path;

/// Atomar schreiben: erst in eine Nachbardatei, auf Platte synchronisieren, dann
/// atomar ueber das Ziel umbenennen. Verhindert, dass ein Absturz oder Stromausfall
/// mitten im Schreiben die Zieldatei (z.B. den Tresor) leert oder halb beschreibt.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    // std::fs::rename ersetzt auf Windows (MoveFileEx REPLACE_EXISTING) und Unix atomar.
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Eine JSON-Liste laden. Fehlt die Datei, leere Liste. Ist sie vorhanden aber
/// beschaedigt, wird sie als .bak beiseitegeschoben (nicht still ueberschrieben)
/// und leer gestartet, damit gute Daten nicht unbemerkt verloren gehen.
pub fn load_json_vec<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<T>>(&bytes) {
            Ok(items) => items,
            Err(e) => {
                let bak = path.with_extension("bak");
                let _ = std::fs::rename(path, &bak);
                tracing::error!(
                    "Datei {} beschaedigt ({e}), Backup unter {}, starte leer",
                    path.display(),
                    bak.display()
                );
                Vec::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            tracing::error!("Datei {} nicht lesbar: {e}, starte leer", path.display());
            Vec::new()
        }
    }
}
