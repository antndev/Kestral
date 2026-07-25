# Changelog

All notable changes to Kestral are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and semantic versioning.

## 0.1.9 - 2026-07-25

### Fixed
- AI access remembers its on or off state on disk and restores it after a restart or update. Only turning it off yourself keeps it off.

## 0.1.8 - 2026-07-25

### Changed
- Lighter blue app icon background.
- The window title bar shows the feather alone, without the badge.

## 0.1.7 - 2026-07-25

### Added
- Settings shows the current version and a polished in-app changelog.

## 0.1.6 - 2026-07-25

### Fixed
- Release builds now publish reliably, so self-update always finds the latest version.

## 0.1.5 - 2026-07-24

### Changed
- AI access turns on immediately after an update when "on by default" is set, with no lag.
- Calmer check-for-updates animation with the status on the right.

## 0.1.4 - 2026-07-24

### Changed
- New app icon: a white feather on a bluish-black badge.

## 0.1.3 - 2026-07-24

### Added
- Update dialog on launch offering "Update now" or "Later".
- Sidebar button that appears when an update is available.

## 0.1.2 - 2026-07-24

### Added
- Application icon.

## 0.1.1 - 2026-07-24

### Added
- Self-update through GitHub releases with signed installers.
- Updates panel in Settings.

## 0.1.0 - 2026-07-24

### Added
- SSH client with a real terminal and multiple sessions per host.
- SFTP file browser and transfers.
- Encrypted vault for keys and passwords (Argon2id, XChaCha20-Poly1305) with a change-master-password option.
- Built-in MCP server for controlled AI access: off by default, per-host policy (locked, confirm, free), approval dialogs and a full audit log.
- Runnable scripts across hosts with an embedded terminal.
- Ed25519 key generation and credential reveal in the keychain.
