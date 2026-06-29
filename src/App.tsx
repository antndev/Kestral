import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import {
  Server,
  HardDrive,
  ScrollText,
  KeyRound,
  Code,
  Cpu,
  Lock,
  Plus,
  Search,
  Pencil,
  Trash2,
  Check,
  Copy,
  TerminalSquare,
  Settings,
  X,
} from "lucide-react";

import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  SidebarRail,
  SidebarGroup,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ShinyText from "@/components/ui/shiny-text";
import DotField from "@/components/ui/dot-field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command";

import * as api from "./api";
import type {
  AiPolicy,
  AiStatus,
  ApprovalRequest,
  AuditEntry,
  AuthMethod,
  Host,
  McpInfo,
  SecretKind,
  SecretMeta,
  Snippet,
} from "./api";
import { SshTerminal } from "./SshTerminal";
import { usePrefs, THEMES, ANIM_SPEEDS } from "./lib/prefs";
import type { Theme, AnimSpeed } from "./lib/prefs";
import { TERMINAL_THEMES, termThemeOf } from "./lib/terminal-themes";
import type { ITheme } from "@xterm/xterm";

/* ----------------------------- helpers ----------------------------- */

function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

const POLICIES: AiPolicy[] = ["locked", "confirm", "free"];
const POLICY_LABEL: Record<AiPolicy, string> = {
  locked: "Blocked",
  confirm: "Ask",
  free: "Free",
};

type Section = "hosts" | "logs" | "keychain" | "snippets" | "mcp" | "settings";

const NAV: { id: Section; label: string; icon: typeof Server }[] = [
  { id: "hosts", label: "Hosts", icon: HardDrive },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "keychain", label: "Keychain", icon: KeyRound },
  { id: "snippets", label: "Snippets", icon: Code },
  { id: "mcp", label: "MCP", icon: Cpu },
];

/* ----------------------------- theme + prefs ----------------------------- */

const DURATIONS = [
  { id: "15", label: "15m" },
  { id: "30", label: "30m" },
  { id: "60", label: "1h" },
  { id: "240", label: "4h" },
];

/* ----------------------------- root ----------------------------- */

export default function App() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const refreshVault = useCallback(async () => {
    setExists(await api.vaultExists());
    setUnlocked(await api.vaultStatus());
  }, []);

  useEffect(() => {
    refreshVault();
  }, [refreshVault]);

  if (exists === null) {
    return (
      <div className="h-screen flex items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!unlocked) return <Unlock exists={exists} onUnlocked={refreshVault} />;
  return <Shell onLock={refreshVault} />;
}

/* ----------------------------- unlock ----------------------------- */

function Unlock({ exists, onUnlocked }: { exists: boolean; onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setErr("");
    if (!exists && pw !== pw2) {
      setErr("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (exists) await api.vaultUnlock(pw);
      else await api.vaultCreate(pw);
      onUnlocked();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="relative h-screen w-screen bg-background text-foreground flex items-center justify-center p-4 overflow-hidden">
      <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(circle_at_center,transparent_12%,black_68%)]">
        <DotField
          dotSpacing={18}
          dotRadius={1.6}
          bulgeStrength={55}
          gradientFrom="rgba(150,150,162,0.5)"
          gradientTo="rgba(150,150,162,0.16)"
          glowColor="rgba(255,255,255,0.05)"
        />
      </div>
      <div className="relative w-full max-w-sm">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-xl">{exists ? "Unlock vault" : "Create your vault"}</CardTitle>
            <CardDescription>
              {exists
                ? "Enter your master password to continue."
                : "Set a master password. You will need it every time you open the app."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && submit()}>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Master password</Label>
                <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" autoFocus disabled={busy} />
              </div>
              {!exists && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">Repeat password</Label>
                  <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••" disabled={busy} />
                </div>
              )}
              {err && <p className="text-destructive text-sm">{err}</p>}
            </div>
            {!exists && (
              <ul className="flex flex-col gap-2 text-xs text-muted-foreground border-t pt-4">
                <li className="flex items-center gap-2"><Lock className="size-3.5 shrink-0 text-foreground/70" />Keys and passwords are encrypted locally.</li>
                <li className="flex items-center gap-2"><Cpu className="size-3.5 shrink-0 text-foreground/70" />AI access is off by default, approved per host.</li>
                <li className="flex items-center gap-2"><Server className="size-3.5 shrink-0 text-foreground/70" />Stays on your machine. No cloud, no telemetry.</li>
              </ul>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button className="w-full" size="lg" disabled={!pw || busy} onClick={submit}>
              {busy && <Spinner className="size-4" />}
              {exists ? "Unlock" : "Create vault"}
            </Button>
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3 shrink-0" />
              Encrypted locally with XChaCha20-Poly1305.
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}

/* ----------------------------- shell ----------------------------- */

type SessionTab = { tabId: string; host: Host };

function Shell({ onLock }: { onLock: () => void }) {
  const [section, setSection] = useState<Section>("hosts");
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [aiActive, setAiActive] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.aiStatus();
        if (alive) setAiActive(s.active);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const un = listen<ApprovalRequest>("approval-request", (e) => {
      setApprovals((q) => (q.find((r) => r.id === e.payload.id) ? q : [...q, e.payload]));
    });
    const unExp = listen<string>("approval-expired", (e) => {
      setApprovals((q) => q.filter((r) => r.id !== e.payload));
    });
    return () => {
      un.then((f) => f());
      unExp.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const answerApproval = useCallback(async (id: string, approved: boolean) => {
    try {
      await api.approvalRespond(id, approved);
    } catch {
      /* ignore */
    } finally {
      setApprovals((q) => q.filter((r) => r.id !== id));
    }
  }, []);

  function openSession(host: Host) {
    const tabId = crypto.randomUUID();
    setSessions((s) => [...s, { tabId, host }]);
    setActiveSession(tabId);
  }
  function closeSession(tabId: string) {
    setSessions((s) => s.filter((t) => t.tabId !== tabId));
    setActiveSession((cur) => (cur === tabId ? null : cur));
  }
  function onHostUpdated(h: Host) {
    setSessions((s) => s.map((t) => (t.host.id === h.id ? { ...t, host: h } : t)));
  }
  function onHostDeleted(id: string) {
    setActiveSession((cur) => {
      const t = sessions.find((x) => x.tabId === cur);
      return t && t.host.id === id ? null : cur;
    });
    setSessions((s) => s.filter((t) => t.host.id !== id));
  }
  function goSection(s: Section) {
    setSection(s);
    setActiveSession(null);
  }
  async function lock() {
    await api.vaultLock();
    onLock();
  }

  return (
    <SidebarProvider>
      {approvals[0] && <ApprovalModal req={approvals[0]} onAnswer={answerApproval} />}
      <ConnectPalette open={paletteOpen} onOpenChange={setPaletteOpen} onConnect={openSession} />

      <Sidebar collapsible="icon" className="[border-right-color:var(--term-bg)]">
        <SidebarHeader>
          <div className="flex items-center px-1 py-1">
            <SidebarTrigger />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {NAV.map((n) => {
                const I = n.icon;
                const navActive = section === n.id && !activeSession;
                return (
                  <SidebarMenuItem key={n.id}>
                    <SidebarMenuButton
                      isActive={navActive}
                      onClick={() => goSection(n.id)}
                      tooltip={n.label}
                      className="relative"
                    >
                      {navActive && (
                        <motion.span
                          layoutId="nav-active"
                          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
                          transition={{ type: "spring", stiffness: 500, damping: 34 }}
                        />
                      )}
                      <I className="size-4 shrink-0 transition-transform group-hover/menu-item:scale-110" />
                      <span>{n.label}</span>
                      {n.id === "mcp" && aiActive && (
                        <span className="ml-auto size-2 rounded-full bg-success" />
                      )}
                      {n.id === "logs" && approvals.length > 0 && (
                        <Badge variant="warning" className="ml-auto">
                          {approvals.length}
                        </Badge>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              {(() => {
                const settingsActive = section === "settings" && !activeSession;
                return (
                  <SidebarMenuButton
                    isActive={settingsActive}
                    onClick={() => goSection("settings")}
                    tooltip="Settings"
                    className="relative"
                  >
                    {settingsActive && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                    )}
                    <Settings className="size-4 shrink-0 transition-transform group-hover/menu-item:scale-110" />
                    <span>Settings</span>
                  </SidebarMenuButton>
                );
              })()}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={lock} tooltip="Lock">
                <Lock className="size-4" />
                <span>Lock</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="h-11 flex items-center gap-1 pl-1 pr-2 border-b shrink-0">
          <div className="flex items-center min-w-0 flex-1 overflow-x-auto no-scrollbar">
            {sessions.length > 0 && (
              <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
                {sessions.map((t) => (
                  <TermTab
                    key={t.tabId}
                    label={t.host.name}
                    active={activeSession === t.tabId}
                    onSelect={() => setActiveSession(t.tabId)}
                    onClose={() => closeSession(t.tabId)}
                  />
                ))}
              </div>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => setPaletteOpen(true)} aria-label="New session">
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Connect (Ctrl+K)</TooltipContent>
          </Tooltip>
        </header>

        <div className="flex-1 min-h-0 relative">
          <div className={activeSession ? "hidden" : "h-full overflow-y-auto"}>
            <div key={section} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out">
              {section === "hosts" ? (
                <HostsView onOpen={openSession} onHostUpdated={onHostUpdated} onHostDeleted={onHostDeleted} />
              ) : section === "logs" ? (
                <LogsView approvals={approvals} onAnswer={answerApproval} />
              ) : section === "keychain" ? (
                <KeychainView />
              ) : section === "snippets" ? (
                <SnippetsView />
              ) : section === "mcp" ? (
                <McpView />
              ) : (
                <SettingsView />
              )}
            </div>
          </div>
          {sessions.map((t) => (
            <div key={t.tabId} className={activeSession === t.tabId ? "absolute inset-0" : "hidden"}>
              <SshTerminal hostId={t.host.id} />
            </div>
          ))}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function TermTab({
  label,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className="group relative inline-flex items-center gap-1.5 pl-2.5 pr-1 h-7 rounded-md shrink-0 cursor-pointer text-sm whitespace-nowrap"
    >
      {active && (
        <motion.span
          layoutId="term-tab-active"
          className="absolute inset-0 rounded-md bg-background shadow-sm"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      )}
      <TerminalSquare
        className={"relative z-10 size-3.5 shrink-0 transition-colors " + (active ? "text-foreground" : "text-muted-foreground")}
      />
      <span
        className={
          "relative z-10 whitespace-nowrap transition-colors " +
          (active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")
        }
      >
        {label}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="relative z-10 grid size-5 place-items-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground transition-colors"
        aria-label="Close tab"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/* ----------------------------- connect palette ----------------------------- */

function ConnectPalette({
  open,
  onOpenChange,
  onConnect,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConnect: (h: Host) => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  useEffect(() => {
    if (open) api.hostList().then(setHosts).catch(() => setHosts([]));
  }, [open]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search a host to connect…" />
      <CommandList>
        <CommandEmpty>No hosts found.</CommandEmpty>
        {hosts.map((h) => (
          <CommandItem
            key={h.id}
            value={`${h.name} ${h.username}@${h.hostname}`}
            onSelect={() => {
              onConnect(h);
              onOpenChange(false);
            }}
          >
            <Server className="size-4 text-muted-foreground" />
            <span className="flex flex-col">
              <span>{h.name}</span>
              <span className="text-xs text-muted-foreground">
                {h.username}@{h.hostname}:{h.port}
              </span>
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

/* ----------------------------- hosts ----------------------------- */

function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center animate-in fade-in-0 zoom-in-95 duration-500">
      {icon && (
        <div className="size-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="text-base font-medium">{title}</div>
      {hint && <p className="text-sm text-muted-foreground max-w-xs">{hint}</p>}
    </div>
  );
}

function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Segmentierte Auswahl mit gleitendem, animiertem Aktiv-Indikator (motion). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "default";
}) {
  const id = useId();
  const h = size === "sm" ? "h-7" : "h-8";
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`relative ${h} px-3 rounded-md text-sm font-medium transition-colors duration-200 ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-md bg-background shadow-sm"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function HostsView({
  onOpen,
  onHostUpdated,
  onHostDeleted,
}: {
  onOpen: (h: Host) => void;
  onHostUpdated: (h: Host) => void;
  onHostDeleted: (id: string) => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<null | "new" | Host>(null);
  const [toDelete, setToDelete] = useState<Host | null>(null);

  const refresh = useCallback(async () => setHosts(await api.hostList()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.hostname.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q),
    );
  }, [hosts, query]);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2 rounded-md bg-card border px-3 h-9 focus-within:border-ring transition-colors">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a host or ssh user@hostname…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
        </div>
        <Button onClick={() => setPanel("new")}>
          <Plus className="size-4" /> New host
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Server className="size-6" />}
          title={hosts.length === 0 ? "No hosts yet" : "No matches"}
          hint={hosts.length === 0 ? "Add your first host to get started." : "Try a different search."}
        />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
          {filtered.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              onConnect={() => onOpen(h)}
              onEdit={() => setPanel(h)}
              onDelete={() => setToDelete(h)}
            />
          ))}
        </div>
      )}

      {panel && (
        <HostSheet
          host={panel === "new" ? null : panel}
          onClose={() => setPanel(null)}
          onSaved={refresh}
          onUpdated={onHostUpdated}
          onConnect={(h) => {
            setPanel(null);
            onOpen(h);
          }}
        />
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete host"
          message={`Delete "${toDelete.name}"? This cannot be undone.`}
          onConfirm={async () => {
            const id = toDelete.id;
            try {
              await api.hostRemove(id);
              onHostDeleted(id);
            } finally {
              setToDelete(null);
              refresh();
            }
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

function HostCard({
  host,
  onConnect,
  onEdit,
  onDelete,
}: {
  host: Host;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onDoubleClick={onConnect}
      className="group relative flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-ring"
    >
      <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); onEdit(); }} aria-label="Edit host">
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); onDelete(); }} aria-label="Delete host">
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-md bg-muted flex items-center justify-center text-base font-semibold uppercase text-muted-foreground shrink-0">
          {host.name.trim().charAt(0) || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate text-sm">{host.name}</div>
          <div className="text-xs text-muted-foreground truncate">
            {host.username}@{host.hostname}:{host.port}
          </div>
        </div>
      </div>
      <Button size="sm" className="w-full" onClick={onConnect}>
        Connect
      </Button>
    </div>
  );
}

const NEW_SECRET = "__new__";

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function HostSheet({
  host,
  onClose,
  onSaved,
  onConnect,
  onUpdated,
}: {
  host: Host | null;
  onClose: () => void;
  onSaved: () => void;
  onConnect: (h: Host) => void;
  onUpdated: (h: Host) => void;
}) {
  const editing = host !== null;
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  useEffect(() => {
    api.secretList().then(setSecrets).catch(() => setSecrets([]));
  }, []);
  const keyIds = useMemo(() => secrets.filter((s) => s.kind === "private_key").map((s) => s.id), [secrets]);
  const pwIds = useMemo(() => secrets.filter((s) => s.kind === "password").map((s) => s.id), [secrets]);

  const [name, setName] = useState(host?.name ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [port, setPort] = useState(host?.port ?? 22);
  const [username, setUsername] = useState(host?.username ?? "");
  const [authKind, setAuthKind] = useState<"password" | "key" | "agent">(host?.auth.kind ?? "key");

  const initialSecret =
    host && (host.auth.kind === "key" || host.auth.kind === "password") ? host.auth.secret_id : NEW_SECRET;
  const [secretSel, setSecretSel] = useState<string>(initialSecret);
  const [newSecretId, setNewSecretId] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const options = authKind === "key" ? keyIds : pwIds;
  const effectiveSel = options.includes(secretSel) ? secretSel : NEW_SECRET;

  // Persistiert den Host (neu oder bearbeitet) und gibt ihn zurueck, oder null bei Fehler.
  async function persist(): Promise<Host | null> {
    setErr("");
    setBusy(true);
    try {
      let auth: AuthMethod;
      if (authKind === "agent") {
        auth = { kind: "agent" };
      } else {
        let secretId = effectiveSel;
        if (effectiveSel === NEW_SECRET) {
          if (!newSecretId || !newSecretValue) throw "Enter an ID and value for the new secret";
          await api.secretPut(newSecretId, authKind === "key" ? "private_key" : "password", newSecretValue);
          secretId = newSecretId;
        }
        auth = authKind === "key" ? { kind: "key", secret_id: secretId } : { kind: "password", secret_id: secretId };
      }
      const safePort = Number.isFinite(port) ? Math.min(65535, Math.max(1, Math.trunc(port))) : 22;
      if (editing && host) {
        const updated = { ...host, name, hostname, port: safePort, username, auth };
        await api.hostUpdate(updated);
        onUpdated(updated);
        return updated;
      }
      return await api.hostAdd({ name, hostname, port: safePort, username, auth, ai_policy: "locked" });
    } catch (e) {
      setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const h = await persist();
    if (h) {
      onSaved();
      onClose();
    }
  }

  // Erst speichern, dann mit den aktuellen (gespeicherten) Daten verbinden.
  async function saveAndConnect() {
    const h = await persist();
    if (h) {
      onSaved();
      onConnect(h);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[400px] sm:max-w-[400px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle>{editing ? "Host details" : "New host"}</SheetTitle>
          <SheetDescription className="sr-only">Configure the SSH host.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">
          <FormSection title="Address">
            <LabeledField label="Hostname">
              <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="example.com" />
            </LabeledField>
          </FormSection>

          <FormSection title="General">
            <LabeledField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" />
            </LabeledField>
            <LabeledField label="Port">
              <Input
                inputMode="numeric"
                value={String(port)}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                  setPort(Number.isFinite(n) ? n : 22);
                }}
                placeholder="22"
              />
            </LabeledField>
          </FormSection>

          <FormSection title="Credentials">
            <LabeledField label="User">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
            </LabeledField>
            <LabeledField label="Authentication">
              <Select value={authKind} onValueChange={(v) => v && setAuthKind(v as "password" | "key")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="key">Key</SelectItem>
                  <SelectItem value="password">Password</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={authKind === "key" ? "Key" : "Password"}>
              <Select value={effectiveSel} onValueChange={(v) => v && setSecretSel(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_SECRET}>
                    {authKind === "key" ? "Import new key…" : "New password…"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            {effectiveSel === NEW_SECRET && (
              <div className="flex flex-col gap-3 rounded-md border p-3">
                <LabeledField label="Save as (ID)">
                  <Input value={newSecretId} onChange={(e) => setNewSecretId(e.target.value)} placeholder={authKind === "key" ? "prod-key" : `${username || "user"}@${hostname || "host"}`} />
                </LabeledField>
                <LabeledField label={authKind === "key" ? "Private key (paste)" : "Password"}>
                  <Input
                    type={authKind === "key" ? "text" : "password"}
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    placeholder={authKind === "key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "••••••••"}
                  />
                </LabeledField>
              </div>
            )}
          </FormSection>

          {err && <p className="text-destructive text-sm">{err}</p>}
        </div>
        <SheetFooter>
          {editing ? (
            <div className="flex items-center gap-2 w-full justify-end">
              <Button variant="secondary" onClick={save} disabled={busy}>Save</Button>
              <Button onClick={saveAndConnect} disabled={busy}>Connect</Button>
            </div>
          ) : (
            <Button className="w-full" onClick={save} disabled={busy || !name || !hostname || !username}>
              {busy && <Spinner className="size-4" />}Add host
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ----------------------------- keychain ----------------------------- */

function KeychainView() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<SecretMeta | null>(null);
  const refresh = useCallback(async () => setSecrets(await api.secretList()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <PageHeader
        title="Keychain"
        subtitle="Keys and passwords, encrypted in the vault. Hosts reference them by ID."
        action={<Button onClick={() => setAdding(true)}><Plus className="size-4" /> New credential</Button>}
      />

      {secrets.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="No credentials yet" hint="Add a key or password; hosts reference them by ID." />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
          {secrets.map((s) => {
            const isKey = s.kind === "private_key";
            return (
              <div
                key={s.id}
                className="group relative flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-ring"
              >
                <div
                  className={
                    "size-10 rounded-md flex items-center justify-center shrink-0 bg-muted " +
                    (isKey ? "text-foreground" : "text-muted-foreground")
                  }
                >
                  {isKey ? <KeyRound className="size-5" /> : <Lock className="size-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{s.id}</div>
                  <div className="text-xs text-muted-foreground">{isKey ? "Private key" : "Password"}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setToDelete(s)}
                  aria-label="Delete credential"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {adding && <KeychainSheet onClose={() => setAdding(false)} onSaved={refresh} />}

      {toDelete && (
        <ConfirmDialog
          title="Delete credential"
          message={`Delete "${toDelete.id}"? Hosts using it will fail to authenticate.`}
          onConfirm={async () => {
            try {
              await api.secretDelete(toDelete.id);
            } finally {
              setToDelete(null);
              refresh();
            }
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

function KeychainSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState<SecretKind>("password");
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setErr("");
    setBusy(true);
    try {
      await api.secretPut(id, kind, value);
      onSaved();
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[400px] sm:max-w-[400px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle>New credential</SheetTitle>
          <SheetDescription className="sr-only">Add a key or password to the vault.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          <LabeledField label="ID">
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="prod-key" />
          </LabeledField>
          <LabeledField label="Type">
            <Select value={kind} onValueChange={(v) => v && setKind(v as SecretKind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="password">Password</SelectItem>
                <SelectItem value="private_key">Private key</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>
          <LabeledField label="Value (encrypted)">
            <Input
              type={kind === "password" ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === "private_key" ? "-----BEGIN OPENSSH PRIVATE KEY-----" : "••••••••"}
            />
          </LabeledField>
          {err && <p className="text-destructive text-sm">{err}</p>}
        </div>
        <SheetFooter>
          <Button className="w-full" onClick={save} disabled={busy || !id || !value}>
            {busy && <Spinner className="size-4" />}Save credential
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ----------------------------- snippets ----------------------------- */

function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [panel, setPanel] = useState<null | "new" | Snippet>(null);
  const [toDelete, setToDelete] = useState<Snippet | null>(null);

  const refresh = useCallback(async () => {
    setSnippets(await api.snippetList());
    setHosts(await api.hostList());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <PageHeader
        title="Snippets"
        subtitle="Saved scripts, scoped to the hosts you choose."
        action={<Button onClick={() => setPanel("new")}><Plus className="size-4" /> New snippet</Button>}
      />

      {snippets.length === 0 ? (
        <EmptyState icon={<Code className="size-6" />} title="No snippets yet" hint="Save scripts you run often and scope them to hosts." />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
          {snippets.map((s) => (
            <div
              key={s.id}
              onClick={() => setPanel(s)}
              className="group relative rounded-lg border bg-card p-4 cursor-pointer transition-colors hover:border-ring"
            >
              <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); setPanel(s); }} aria-label="Edit snippet">
                  <Pencil className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); setToDelete(s); }} aria-label="Delete snippet">
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="font-medium truncate text-sm pr-12">{s.label}</div>
              <pre className="mt-2 text-xs font-mono whitespace-pre-wrap text-muted-foreground line-clamp-3">{s.script}</pre>
              {s.target_host_ids.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {s.target_host_ids.map((id) => (
                    <Badge key={id} variant="secondary">{hostName(id)}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {panel && (
        <SnippetSheet
          snippet={panel === "new" ? null : panel}
          hosts={hosts}
          onClose={() => setPanel(null)}
          onSaved={refresh}
        />
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete snippet"
          message={`Delete "${toDelete.label}"?`}
          onConfirm={async () => {
            try {
              await api.snippetDelete(toDelete.id);
            } finally {
              setToDelete(null);
              refresh();
            }
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

function SnippetSheet({
  snippet,
  hosts,
  onClose,
  onSaved,
}: {
  snippet: Snippet | null;
  hosts: Host[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = snippet !== null;
  const [label, setLabel] = useState(snippet?.label ?? "");
  const [script, setScript] = useState(snippet?.script ?? "");
  const [targets, setTargets] = useState<string[]>(snippet?.target_host_ids ?? []);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  async function save() {
    setErr("");
    setBusy(true);
    try {
      if (editing && snippet) {
        await api.snippetUpdate({ ...snippet, label, script, target_host_ids: targets });
      } else {
        await api.snippetAdd({ label, script, target_host_ids: targets });
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[400px] sm:max-w-[400px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle>{editing ? "Edit snippet" : "New snippet"}</SheetTitle>
          <SheetDescription className="sr-only">Configure the snippet.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">
          <FormSection title="Snippet">
            <LabeledField label="Name">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Update & reboot" />
            </LabeledField>
            <LabeledField label="Script">
              <Input value={script} onChange={(e) => setScript(e.target.value)} placeholder="sudo apt update && sudo apt upgrade -y" />
            </LabeledField>
          </FormSection>

          <FormSection title="Runs on">
            {hosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hosts yet.</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {hosts.map((h) => (
                  <div
                    key={h.id}
                    onClick={() => toggle(h.id)}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-accent cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={targets.includes(h.id)}
                      onCheckedChange={() => toggle(h.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="flex-1 truncate">{h.name}</span>
                    <span className="text-xs text-muted-foreground truncate">{h.username}@{h.hostname}</span>
                  </div>
                ))}
              </div>
            )}
          </FormSection>

          {err && <p className="text-destructive text-sm">{err}</p>}
        </div>
        <SheetFooter>
          <Button className="w-full" onClick={save} disabled={busy || !label || !script}>
            {editing ? "Save" : "Save snippet"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ----------------------------- logs ----------------------------- */

function decisionVariant(d: string): "success" | "destructive" | "info" | "secondary" {
  if (d === "denied" || d === "error") return "destructive";
  if (d === "user") return "info";
  if (d === "allowed" || d === "approved") return "success";
  return "secondary";
}

function LogsView({
  approvals,
  onAnswer,
}: {
  approvals: ApprovalRequest[];
  onAnswer: (id: string, approved: boolean) => void;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<"activity" | "approvals">("activity");
  const refresh = useCallback(async () => setEntries(await api.auditList()), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
        <Segmented
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "activity", label: "Activity" },
            { value: "approvals", label: approvals.length ? `Approvals (${approvals.length})` : "Approvals" },
          ]}
        />
      </div>

      {tab === "activity" ? (
        entries.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-6" />} title="No activity yet" hint="Commands you run and AI actions appear here." />
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Time</TableHead>
                  <TableHead className="w-44">Host</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead className="w-24">Source</TableHead>
                  <TableHead className="w-28">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries
                  .slice()
                  .reverse()
                  .map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground tabular-nums">{new Date(e.timestamp).toLocaleTimeString()}</TableCell>
                      <TableCell className="truncate">{e.host_name}</TableCell>
                      <TableCell className="font-mono text-xs">{e.command}</TableCell>
                      <TableCell><Badge variant={decisionVariant(e.decision)}>{e.decision}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={e.success ? "success" : "destructive"}>
                          {e.success ? "ok" : "error"}
                          {e.exit_status != null ? ` (${e.exit_status})` : ""}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : approvals.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-6" />} title="No pending approvals" hint="Requests from the AI show up here live." />
      ) : (
        <div className="flex flex-col gap-3 max-w-2xl">
          {approvals.map((r) => (
            <Card key={r.id}>
              <CardContent className="flex flex-col gap-3 pt-4">
                <div className="text-sm">
                  The AI wants to run a command on <span className="font-medium">{r.host_name}</span>.
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all">{r.command}</pre>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => onAnswer(r.id, false)}>Deny</Button>
                  <Button onClick={() => onAnswer(r.id, true)}>Approve</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- mcp ----------------------------- */

function McpView() {
  const { aiMinutes, setAiMinutes } = usePrefs();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await api.aiStatus());
    setHosts(await api.hostList());
  }, []);
  useEffect(() => {
    refresh();
    api.mcpInfo().then(setInfo);
    const t = setInterval(() => api.aiStatus().then(setStatus), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const active = status?.active ?? false;

  async function toggle(on: boolean) {
    if (on) await api.aiEnable(aiMinutes);
    else await api.aiDisable();
    setStatus(await api.aiStatus());
  }

  const remaining = useMemo(() => {
    if (!active || !status?.expires_at) return null;
    const ms = new Date(status.expires_at).getTime() - Date.now();
    if (ms <= 0) return null;
    return Math.max(1, Math.round(ms / 60000));
  }, [active, status]);

  const cmd = info
    ? `claude mcp add --transport http helmsman ${info.url} --header "Authorization: Bearer ${info.token}"`
    : "";

  async function copy() {
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="px-6 pt-5 pb-12 max-w-3xl flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">MCP &amp; AI access</h2>
        <p className="text-sm text-muted-foreground">
          Optional. Lets an AI run commands through Helmsman, with your approval. Off by default.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Switch checked={active} onCheckedChange={toggle} aria-label="AI access" />
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-2">
                {active ? <ShinyText text="AI access" className="font-medium" speed={3} /> : "AI access"}
                <Badge variant={active ? "success" : "secondary"}>{active ? "ON" : "OFF"}</Badge>
              </div>
              <div className="text-sm text-muted-foreground">
                {active
                  ? remaining != null
                    ? `Auto-off in ${remaining} min · ${new Date(status!.expires_at!).toLocaleTimeString()}`
                    : "Active"
                  : "Turn on to allow AI commands for a limited time."}
              </div>
            </div>
          </div>
          {!active && (
            <div className="flex items-center gap-3 border-t pt-4">
              <span className="text-sm text-muted-foreground">Turn on for</span>
              <Segmented
                value={String(aiMinutes)}
                onChange={(v) => setAiMinutes(Number(v))}
                size="sm"
                options={DURATIONS.map((d) => ({ value: d.id, label: d.label }))}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {info && (
        <Card>
          <CardHeader>
            <CardTitle>MCP server</CardTitle>
            <CardDescription>
              Endpoint {info.url}{" "}
              <span className={info.running ? "text-success" : "text-muted-foreground"}>
                {info.running ? "(running)" : "(not active yet)"}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm">Connect Claude Code with:</p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">{cmd}</pre>
              <Button size="sm" variant="secondary" onClick={copy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Per-host permission</CardTitle>
          <CardDescription>
            Blocked: AI cannot touch it. Ask: every command needs approval. Free: AI may run freely.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hosts yet.</p>
          ) : (
            hosts.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm truncate">{h.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{h.username}@{h.hostname}</div>
                </div>
                <Segmented
                  value={h.ai_policy}
                  size="sm"
                  onChange={async (p) => {
                    await api.hostSetPolicy(h.id, p);
                    refresh();
                  }}
                  options={POLICIES.map((p) => ({ value: p, label: POLICY_LABEL[p] }))}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------------- settings ----------------------------- */

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const ANSI_SWATCHES: (keyof ITheme)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

function TermPreview({ theme }: { theme: ITheme }) {
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="p-3 font-mono text-xs leading-relaxed" style={{ background: theme.background, color: theme.foreground }}>
        <div>
          <span style={{ color: theme.green }}>user@helmsman</span>
          <span style={{ color: theme.foreground }}>:</span>
          <span style={{ color: theme.blue }}>~/project</span>
          <span style={{ color: theme.foreground }}>$ ls --color</span>
        </div>
        <div>
          <span style={{ color: theme.blue }}>src</span>
          {"  "}
          <span style={{ color: theme.cyan }}>README.md</span>
          {"  "}
          <span style={{ color: theme.yellow }}>Cargo.toml</span>
          {"  "}
          <span style={{ color: theme.red }}>error.log</span>
        </div>
        <div className="mt-2 flex gap-1">
          {ANSI_SWATCHES.map((k) => (
            <span key={k} className="size-3.5 rounded-sm" style={{ background: theme[k] as string }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsView() {
  const { theme, setTheme, anim, setAnim, termTheme, setTermTheme, aiMinutes, setAiMinutes } = usePrefs();
  const termIds = Object.keys(TERMINAL_THEMES);
  const preview = termThemeOf(termTheme).theme;

  return (
    <div className="px-6 pt-5 pb-12 max-w-3xl flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground">Appearance, motion and terminal. Everything is stored locally.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SettingRow label="Theme" hint="Color mode of the app.">
            <Segmented<Theme>
              value={theme}
              onChange={setTheme}
              size="sm"
              options={THEMES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            />
          </SettingRow>
          <SettingRow label="Animations" hint="Speed of UI motion and transitions.">
            <Segmented<AnimSpeed>
              value={anim}
              onChange={setAnim}
              size="sm"
              options={ANIM_SPEEDS.map((a) => ({ value: a, label: a.charAt(0).toUpperCase() + a.slice(1) }))}
            />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
          <CardDescription>Color scheme of the terminal emulator. Applies to all sessions.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SettingRow label="Color scheme" hint="Also tints the frame and the sidebar edge.">
            <Select value={termTheme} onValueChange={setTermTheme}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {termIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {TERMINAL_THEMES[id].name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <TermPreview theme={preview} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI access</CardTitle>
          <CardDescription>Default duration used when you switch AI access on.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Default duration" hint="Preset for the auto-off timer.">
            <Segmented
              value={String(aiMinutes)}
              onChange={(v) => setAiMinutes(Number(v))}
              size="sm"
              options={DURATIONS.map((d) => ({ value: d.id, label: d.label }))}
            />
          </SettingRow>
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------------- dialogs ----------------------------- */

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {confirmLabel ?? "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ApprovalModal({
  req,
  onAnswer,
}: {
  req: ApprovalRequest;
  onAnswer: (id: string, approved: boolean) => void;
}) {
  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approval required</AlertDialogTitle>
          <AlertDialogDescription>The AI wants to run a command on {req.host_name}.</AlertDialogDescription>
        </AlertDialogHeader>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all">{req.command}</pre>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer(req.id, false)}>Deny</AlertDialogCancel>
          <AlertDialogAction onClick={() => onAnswer(req.id, true)}>Approve</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
