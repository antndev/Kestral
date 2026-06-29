import { invoke } from "@tauri-apps/api/core";

// Typen, die die Rust-Modelle spiegeln.
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
}

export interface NewHost {
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  ai_policy: AiPolicy;
}

export interface AiStatus {
  active: boolean;
  expires_at: string | null;
  default_minutes: number;
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

// Tresor
export const vaultExists = () => invoke<boolean>("vault_exists");
export const vaultStatus = () => invoke<boolean>("vault_status");
export const vaultCreate = (master: string) => invoke<void>("vault_create", { master });
export const vaultUnlock = (master: string) => invoke<void>("vault_unlock", { master });
export const vaultLock = () => invoke<void>("vault_lock");

// Geheimnisse
export const secretPut = (id: string, kind: SecretKind, value: string) =>
  invoke<void>("secret_put", { id, kind, value });
export const secretList = () => invoke<SecretMeta[]>("secret_list");
export const secretDelete = (id: string) => invoke<void>("secret_delete", { id });

// Hosts
export const hostList = () => invoke<Host[]>("host_list");
export const hostAdd = (host: NewHost) => invoke<Host>("host_add", { host });
export const hostUpdate = (host: Host) => invoke<void>("host_update", { host });
export const hostRemove = (id: string) => invoke<void>("host_remove", { id });
export const hostSetPolicy = (id: string, policy: AiPolicy) =>
  invoke<void>("host_set_policy", { id, policy });

// Snippets
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

// KI-Schalter
export const aiStatus = () => invoke<AiStatus>("ai_status");
export const aiEnable = (minutes?: number) => invoke<void>("ai_enable", { minutes });
export const aiDisable = () => invoke<void>("ai_disable");

// Freigabe
export const approvalRespond = (id: string, approved: boolean) =>
  invoke<void>("approval_respond", { id, approved });

// Protokoll
export const auditList = () => invoke<AuditEntry[]>("audit_list");
export const auditUserCommand = (hostId: string, command: string) =>
  invoke<void>("audit_user_command", { hostId, command });

// MCP
export const mcpInfo = () => invoke<McpInfo>("mcp_info");

// Manueller Lauf
export const runCommandUi = (hostId: string, command: string) =>
  invoke<CommandOutput>("run_command_ui", { hostId, command });
