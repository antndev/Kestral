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

## License

Kestral is source-available, not open source. It is free for personal and other
noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE): private
use, homelab, hobby projects, study, and use by nonprofits, schools and government
bodies. Any commercial use, including internal use inside a for-profit company,
requires a separate commercial license.

Commercial licensing: write to anton@schmid-koenig.de. Copyright 2026 Anton Schmid-Koenig.
