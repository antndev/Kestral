# Changelog

All notable changes to Kestral are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and semantic versioning.

## 0.1.20 - 2026-07-29

### Changed
- Clearer error when a port forward's local bind address does not belong to this machine. Instead of a raw OS error, it explains that the left side is where Kestral listens here (use 127.0.0.1 or 0.0.0.0) and the remote target belongs on the right side.

## 0.1.19 - 2026-07-28

### Changed
- Faster release builds (build configuration only), no change in behaviour: the desktop build no longer produces the unused mobile library outputs, and CI caches npm.

## 0.1.18 - 2026-07-28

### Changed
- Internal code cleanup, no change in behaviour.

## 0.1.17 - 2026-07-28

### Fixed
- A port forward bound to "localhost" no longer shows the "reachable from your network" warning. localhost and ::1 count as loopback, just like 127.0.0.1, so the tunnel stays on this machine.

## 0.1.16 - 2026-07-28

### Added
- Port forwards can bind to a chosen local address, not just loopback. Leave it at 127.0.0.1 to keep a tunnel on this machine, or set 0.0.0.0 or a LAN address so other devices on your network can reach it, for example to tunnel a remote service and open it from your phone. A warning shows when a forward is exposed beyond this machine.

## 0.1.15 - 2026-07-28

### Fixed
- Starting a port forward no longer trips over "address already in use" when autostart and a manual start race, or when a tunnel is stopped and immediately started again. Stopping now waits until the local port is actually released, starting reserves the slot so it cannot run twice, and if another program really holds the port the message says so plainly.

## 0.1.14 - 2026-07-28

### Fixed
- Host cards no longer stretch to match the tallest card in their row, so a card with port forwards no longer leaves empty space at the bottom of its neighbours.

## 0.1.13 - 2026-07-28

### Added
- Local port forwarding per host, like `ssh -L`. Configure forwards on a host (local port to a remote host and port, usually localhost) and start or stop each one from the host card, with a live status dot and a one-click open in the browser. Reach a service that only listens locally on the remote, for example a web UI on 127.0.0.1. Listens on the loopback interface only, and optional autostart brings a tunnel up after unlock.

### Changed
- Agent forwarding now signs from the vault instead of your operating system's SSH agent. Pick which vault keys a host may use; Kestral answers the remote's sign requests itself, so the private key never reaches the host, and every signature is written to the audit log. The AI can never turn this on, but a session on a host where you enabled it can use the forwarded keys.

## 0.1.12 - 2026-07-28

### Fixed
- SSH connections stay alive during idle periods. Keepalives run every 15 seconds and short interruptions are tolerated, so a session no longer drops just because the window was in the background for a while.
- The terminal cursor blinks at a normal rate again instead of racing when the animation-speed setting is changed.

## 0.1.11 - 2026-07-28

### Added
- Per-host SSH agent forwarding (ForwardAgent). Off by default. When enabled, commands on that host can authenticate with the keys in your local SSH agent, for example git push to another server, without putting a private key on the host. Only enable it for hosts you trust.

## 0.1.10 - 2026-07-25

### Changed
- App icon is just the feather now, with no background.

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
