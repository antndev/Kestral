
use std::path::Path;

pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        restrict(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    restrict(&file)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn restrict(_file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Best-effort, one-time hardening of the data directory on Windows: strip
/// inherited ACEs and grant only the current user full control, inherited by
/// everything created inside (vault, audit log, MCP token). On Unix the per-file
/// 0600/0700 modes already handle this, so this is a no-op there. Errors are
/// ignored: %USERPROFILE% is already user-scoped, this is defense in depth.
pub fn harden_dir(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(user) = std::env::var_os("USERNAME") {
            let user = user.to_string_lossy();
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("icacls")
                .arg(path)
                .args(["/inheritance:r", "/grant:r"])
                .arg(format!("{user}:(OI)(CI)F"))
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}
