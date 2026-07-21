# Kestral

Self-hosted SSH client with a built-in MCP server, so an AI can run commands on your
servers under your control. The AI never sees a private key or password. It only asks
Kestral to run a command, and you decide per host whether that needs your approval.

## What it does

- SSH client with a real terminal (xterm), multiple sessions per host, known-hosts TOFU.
- Encrypted vault for hosts, keys and snippets. Master password via Argon2id, payload via
  XChaCha20Poly1305. Secrets never leave the core in plaintext.
- Built-in MCP server (loopback, bearer token) exposing `list_hosts`, `run_command` and
  `get_audit_log` to an AI client like Claude Code.
- AI access is off by default, auto-disables after a timer, and every host has a policy:
  `locked` (AI cannot touch it), `confirm` (every command needs approval), `free`.
- Full audit log separating your own commands from AI activity.

## Stack

- Tauri v2 (Rust core, WebView2 UI)
- russh (ring backend) for SSH
- rmcp + axum for the MCP server
- React 19 + Vite + Tailwind v4, ReUI components (Radix UI)

## Development

```powershell
npm install
npm run tauri dev
```

Frontend-only build check:

```powershell
npm run build
```

## Layout

- `src/` React UI (`App.tsx`, `SshTerminal.tsx`, `components/ui/` ReUI components)
- `src-tauri/src/` Rust core (`ssh.rs`, `vault.rs`, `mcp.rs`, `policy.rs`, `audit.rs`, ...)

## Security

- **Key hierarchy.** Master password to key-encryption key (KEK) via Argon2id
  (v19, m=64 MiB, t=2, p=1, 32-byte key, 16-byte random salt per vault). The KEK
  encrypts the whole vault as one XChaCha20-Poly1305 blob with the header as
  authenticated data. Inside sits a random 32-byte data key (DEK) that encrypts the
  audit log and the host/snippet records. A password change re-derives only the KEK,
  so nothing else has to be rewritten. Opening a vault written with weaker parameters
  transparently re-derives it at current strength.
- **MCP server.** Loopback only (`127.0.0.1:4517`), bearer token (192 bits, constant
  time compare), Host and Origin both validated. No CORS layer, so no browser origin
  is ever granted access.
- **AI is gated.** Off by default. Each host has separate command and file policies
  (`locked` / `confirm` / `free`). Changing a host's address, port or user resets its
  AI policy to `locked`. AI file transfer is confined to `~/.kestral/ai-transfers`;
  paths outside it are refused.
- **Host keys.** Trust-on-first-use with the SHA256 fingerprint logged; a changed key
  is refused with a distinct error. Note: entries currently live in the OpenSSH
  `~/.ssh/known_hosts`, not yet in the app's own encrypted store (`KESTRAL_DATA_DIR`
  does not relocate it). This is an open item.

See [SECURITY.md](SECURITY.md) for the threat model and how to report issues.

## License

Kestral is source-available, not open source. It is free for personal and other
noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE): private
use, homelab, hobby projects, study, and use by nonprofits, schools and government
bodies. Any commercial use, including internal use inside a for-profit company,
requires a separate commercial license.

Commercial licensing: write to antonkonig691@gmail.com. Copyright 2026 Anton.
