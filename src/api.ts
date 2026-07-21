import { invoke } from "@tauri-apps/api/core";

export type AiPolicy = "locked" | "confirm" | "free";
export type SecretKind = "password" | "private_key";

export type AuthMethod =
  | { kind: "password"; secret_id: string }
  | { kind: "key"; secret_id: string }
  | { kind: "agent" };

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  ai_policy: AiPolicy;
  ai_file_policy: AiPolicy;
}

export interface NewHost {
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  ai_policy: AiPolicy;
  ai_file_policy: AiPolicy;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
}

export interface AiStatus {
  active: boolean;
  expires_at: string | null;
  default_minutes: number;
}

export interface AiCaps {
  list_hosts: boolean;
  manage_hosts: boolean;
  list_snippets: boolean;
  manage_snippets: boolean;
  list_secrets: boolean;
  audit_log: boolean;
}

export interface McpInfo {
  url: string;
  token: string;
  running: boolean;
}

export interface SecretMeta {
  id: string;
  kind: SecretKind;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  host_id: string;
  host_name: string;
  command: string;
  decision: string;
  exit_status: number | null;
  success: boolean;
  detail: string | null;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_status: number | null;
}

export interface ApprovalRequest {
  id: string;
  host_id: string;
  host_name: string;
  command: string;
}

export const vaultExists = () => invoke<boolean>("vault_exists");
export const vaultStatus = () => invoke<boolean>("vault_status");
export const vaultCreate = (master: string) => invoke<void>("vault_create", { master });
export const vaultUnlock = (master: string) => invoke<void>("vault_unlock", { master });
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultImport = (path: string, master: string) =>
  invoke<string[]>("vault_import", { path, master });
export const vaultChangeMaster = (current: string, next: string) =>
  invoke<void>("vault_change_master", { current, new: next });

export const secretPut = (id: string, kind: SecretKind, value: string) =>
  invoke<void>("secret_put", { id, kind, value });
export const secretList = () => invoke<SecretMeta[]>("secret_list");
export const secretDelete = (id: string) => invoke<void>("secret_delete", { id });

export interface PubkeyInfo {
  public_key: string;
  fingerprint: string;
}
export const derivePubkey = (privateKey: string) =>
  invoke<PubkeyInfo>("derive_pubkey", { privateKey });

export const hostList = () => invoke<Host[]>("host_list");
export const hostAdd = (host: NewHost) => invoke<Host>("host_add", { host });
export const hostUpdate = (host: Host) => invoke<void>("host_update", { host });
export const hostRemove = (id: string) => invoke<void>("host_remove", { id });
export const hostSetPolicy = (id: string, policy: AiPolicy) =>
  invoke<void>("host_set_policy", { id, policy });
export const hostSetFilePolicy = (id: string, policy: AiPolicy) =>
  invoke<void>("host_set_file_policy", { id, policy });

export const sftpOpen = (id: string, hostId: string) =>
  invoke<string>("sftp_open", { id, hostId });
export const sftpList = (id: string, path: string) =>
  invoke<FileEntry[]>("sftp_list", { id, path });
export const sftpDownload = (id: string, remote: string, local: string) =>
  invoke<number>("sftp_download", { id, remote, local });
export const sftpDownloadDir = (id: string, remote: string, local: string) =>
  invoke<number>("sftp_download_dir", { id, remote, local });
export const sftpUpload = (id: string, local: string, remote: string) =>
  invoke<number>("sftp_upload", { id, local, remote });
export const sftpUploadDir = (id: string, local: string, remote: string) =>
  invoke<number>("sftp_upload_dir", { id, local, remote });
export const sftpReadText = (id: string, path: string) =>
  invoke<string>("sftp_read_text", { id, path });
export const sftpWriteText = (id: string, path: string, content: string) =>
  invoke<void>("sftp_write_text", { id, path, content });
export const sftpMkdir = (id: string, path: string) =>
  invoke<void>("sftp_mkdir", { id, path });
export const sftpRemove = (id: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { id, path, isDir });
export const sftpRename = (id: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { id, from, to });
export const sftpClose = (id: string) => invoke<void>("sftp_close", { id });

export interface Snippet {
  id: string;
  label: string;
  script: string;
  target_host_ids: string[];
}
export interface NewSnippet {
  label: string;
  script: string;
  target_host_ids: string[];
}
export const snippetList = () => invoke<Snippet[]>("snippet_list");
export const snippetAdd = (snippet: NewSnippet) => invoke<Snippet>("snippet_add", { snippet });
export const snippetUpdate = (snippet: Snippet) => invoke<void>("snippet_update", { snippet });
export const snippetDelete = (id: string) => invoke<void>("snippet_delete", { id });

export const aiStatus = () => invoke<AiStatus>("ai_status");
export const aiEnable = (minutes?: number) => invoke<void>("ai_enable", { minutes });
export const aiDisable = () => invoke<void>("ai_disable");
export const aiCaps = () => invoke<AiCaps>("ai_caps");
export const aiSetCaps = (caps: AiCaps) => invoke<void>("ai_set_caps", { caps });

export const approvalRespond = (id: string, approved: boolean) =>
  invoke<void>("approval_respond", { id, approved });

export const auditList = () => invoke<AuditEntry[]>("audit_list");
export const auditUserCommand = (hostId: string, command: string) =>
  invoke<void>("audit_user_command", { hostId, command });

export const mcpInfo = () => invoke<McpInfo>("mcp_info");
export const dataWarnings = () => invoke<string[]>("data_warnings");
export interface RotateResult {
  info: McpInfo;
  reconnected: boolean;
  message: string;
}
export const mcpRotateToken = (name: string) =>
  invoke<RotateResult>("mcp_rotate_token", { name });
export interface ConnectResult {
  ok: boolean;
  message: string;
}
export const mcpConnectClaudeCode = (name: string) =>
  invoke<ConnectResult>("mcp_connect_claude_code", { name });

export interface InstallResult {
  skill_path: string;
  script_path: string;
  runtime: string;
  message: string;
}
export const installSkill = () => invoke<InstallResult>("install_skill");
export const uninstallSkill = () => invoke<string>("uninstall_skill");
export const skillInstalled = () => invoke<boolean>("skill_installed");

export interface Registration {
  name: string;
  url: string;
  connected: boolean;
  is_this_app: boolean;
}
export const mcpListRegistrations = () => invoke<Registration[]>("mcp_list_registrations");
export const mcpRemoveRegistration = (name: string) =>
  invoke<string>("mcp_remove_registration", { name });

export const runCommandUi = (hostId: string, command: string, pty = false) =>
  invoke<CommandOutput>("run_command_ui", { hostId, command, pty });
