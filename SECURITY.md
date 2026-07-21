# Security

Kestral is pre-1.0 and moves fast. Only the latest `0.1.x` is supported.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately:

- GitHub: enable and use Private Vulnerability Reporting on this repository, or
- Email: antonkonig691@gmail.com

I aim to acknowledge within a few days. Please include what you found, how to
reproduce it, and the impact you see.

## Threat model

Kestral is a local desktop app. It holds SSH credentials in an encrypted vault and
runs a loopback MCP server so a local AI client can act on your servers under rules
you set. What it defends against, and what it does not:

- **Vault at rest.** Hosts, keys, snippets and the audit log are encrypted. The
  master password goes through Argon2id (v19, m=64 MiB, t=2, p=1, 32-byte key,
  16-byte random salt) to a key-encryption key, which wraps a random data key that
  encrypts everything else. A password change re-derives only the outer key.
- **MCP surface.** The server binds `127.0.0.1:4517` only, requires a bearer token
  (192 bits from the OS RNG, compared in constant time), and validates Host and
  Origin. It is not exposed to the network or to browsers.
- **AI is gated.** AI access is off by default and every host has a policy:
  `locked`, `confirm` (per-command approval) or `free`. Commands and file transfer
  have separate policies. If the AI repoints a host to a new address, its policy is
  reset to `locked`. AI file transfer is confined to `~/.kestral/ai-transfers`.
- **Host keys.** First contact is trust-on-first-use: the key is recorded and the
  SHA256 fingerprint is logged. A **changed** host key is refused with a distinct
  error, never silently accepted.
- **Not defended:** an attacker who already has your unlocked machine or your OS
  account. Secret wiping in memory is best effort and does not defend against swap,
  hibernation or a core dump. `known_hosts` is currently the OpenSSH file in
  `~/.ssh`, not yet app-owned and encrypted (tracked as an open item).
