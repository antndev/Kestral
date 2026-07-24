import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  Folder,
  ClipboardPaste,
  Import,
  Play,
  X,
  Eye,
  Wand2,
} from "lucide-react";
import { readText as clipReadText, writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";

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
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
  AiCaps,
  AiPolicy,
  AiStatus,
  ApprovalRequest,
  AuditEntry,
  CommandOutput,
  AuthMethod,
  Host,
  SecretKind,
  SecretMeta,
  Snippet,
} from "./api";
import { SshTerminal } from "./SshTerminal";
import { SftpBrowser } from "./SftpBrowser";
import { usePrefs, THEMES } from "./lib/prefs";
import type { Theme } from "./lib/prefs";
import { TERMINAL_THEMES, terminalTheme } from "./lib/terminal-themes";
import type { ITheme } from "@xterm/xterm";

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
  { id: "snippets", label: "Scripts", icon: Code },
  { id: "mcp", label: "AI access", icon: Cpu },
];

const DURATIONS = [
  { id: "15", label: "15m" },
  { id: "30", label: "30m" },
  { id: "60", label: "1h" },
  { id: "240", label: "4h" },
];

export default function App() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

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
    <div className="relative h-screen w-screen bg-background text-foreground flex items-center justify-center p-4 overflow-hidden animate-in fade-in duration-500">
      <div className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(circle_at_center,transparent_12%,black_68%)]">
        <DotField
          dotSpacing={18}
          dotRadius={1.6}
          bulgeStrength={55}
          gradientFrom="rgba(150,150,162,0.5)"
          gradientTo="rgba(150,150,162,0.16)"
          glowColor="transparent"
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
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && submit()}>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium text-muted-foreground">Master password</Label>
                <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" autoFocus disabled={busy} aria-invalid={!!err} />
              </div>
              {!exists && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">Repeat password</Label>
                  <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••" disabled={busy} aria-invalid={!!err} />
                </div>
              )}
              <p className={"-mt-1 min-h-4 text-xs leading-4 " + (err ? "text-destructive" : "invisible")}>
                {err || "·"}
              </p>
            </div>
            {!exists && (
              <ul className="flex flex-col gap-2 text-xs text-muted-foreground border-t pt-4">
                <li className="flex items-center gap-2"><Lock className="size-3.5 shrink-0 text-foreground/70" />Keys and passwords are encrypted locally.</li>
                <li className="flex items-center gap-2"><Cpu className="size-3.5 shrink-0 text-foreground/70" />AI access is off by default, approved per host.</li>
                <li className="flex items-center gap-2"><Server className="size-3.5 shrink-0 text-foreground/70" />Stays on your machine. No cloud, no telemetry.</li>
              </ul>
            )}
            <Button className="w-full" size="lg" disabled={!pw || busy} onClick={submit}>
              {busy && <Spinner className="size-4" />}
              {exists ? "Unlock" : "Create vault"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type SessionTab = { tabId: string; host: Host; kind: "terminal" | "sftp" };
type TopTab = "start" | string;

function Shell({ onLock }: { onLock: () => void }) {
  const { aiAutoEnable, aiMinutes } = usePrefs();
  const [section, setSection] = useState<Section>("hosts");
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [topTab, setTopTab] = useState<TopTab>("start");
  const [aiActive, setAiActive] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [dataWarnings, setDataWarnings] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [locking, setLocking] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.aiStatus();
        if (alive) setAiActive(s.active);
      } catch {
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
    api.dataWarnings().then(setDataWarnings).catch(() => {});
    if (aiAutoEnable) {
      api
        .aiStatus()
        .then((st) => {
          if (!st.active) void api.aiEnable(aiMinutes);
        })
        .catch(() => {});
    }
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
    } finally {
      setApprovals((q) => q.filter((r) => r.id !== id));
    }
  }, []);

  function openSession(host: Host) {
    const tabId = crypto.randomUUID();
    setSessions((s) => [...s, { tabId, host, kind: "terminal" }]);
    setTopTab(tabId);
  }
  function openSftp(host: Host) {
    const existing = sessions.find((s) => s.kind === "sftp" && s.host.id === host.id);
    if (existing) {
      setTopTab(existing.tabId);
      return;
    }
    const tabId = crypto.randomUUID();
    setSessions((s) => [...s, { tabId, host, kind: "sftp" }]);
    setTopTab(tabId);
  }
  function closeSession(tabId: string) {
    setSessions((s) => s.filter((t) => t.tabId !== tabId));
    setTopTab((cur) => (cur === tabId ? "start" : cur));
  }
  const dragTabId = useRef<string | null>(null);
  function reorderTab(targetId: string) {
    const from = dragTabId.current;
    dragTabId.current = null;
    if (!from || from === targetId) return;
    setSessions((s) => {
      const arr = [...s];
      const fi = arr.findIndex((t) => t.tabId === from);
      const ti = arr.findIndex((t) => t.tabId === targetId);
      if (fi < 0 || ti < 0) return arr;
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  }
  function onHostUpdated(h: Host) {
    setSessions((s) => s.map((t) => (t.host.id === h.id ? { ...t, host: h } : t)));
  }
  function onHostDeleted(id: string) {
    const activeIsDeleted = sessions.find((x) => x.tabId === topTab)?.host.id === id;
    if (activeIsDeleted) setTopTab("start");
    setSessions((s) => s.filter((t) => t.host.id !== id));
  }
  function goSection(s: Section) {
    setSection(s);
    setTopTab("start");
  }
  function lock() {
    if (locking) return;
    setLocking(true);
    void api.vaultLock();
    window.setTimeout(onLock, 700);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {locking && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 backdrop-blur-md animate-in fade-in duration-300">
          <div className="flex flex-col items-center gap-4">
            <div className="relative grid place-items-center">
              <span className="absolute size-16 rounded-2xl bg-foreground/10 animate-ping" />
              <div className="relative size-16 rounded-2xl bg-card border shadow-xl grid place-items-center animate-in zoom-in-50 duration-500">
                <Lock className="size-7" />
              </div>
            </div>
            <div className="text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-500">Locking…</div>
          </div>
        </div>
      )}
      {dataWarnings.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-xl rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 shadow-lg backdrop-blur-sm">
          {dataWarnings.map((w) => (
            <p key={w} className="text-sm text-destructive">
              {w}
            </p>
          ))}
          <button
            className="mt-2 text-xs underline text-muted-foreground hover:text-foreground"
            onClick={() => setDataWarnings([])}
          >
            Dismiss
          </button>
        </div>
      )}

      {approvals[0] && <ApprovalModal req={approvals[0]} onAnswer={answerApproval} />}
      <ConnectPalette open={paletteOpen} onOpenChange={setPaletteOpen} onConnect={openSession} onConnectSftp={openSftp} />

      <aside className="w-48 shrink-0 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-1 flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavButton
              key={n.id}
              icon={n.icon}
              label={n.id === "mcp" && aiActive ? <ShinyText text={n.label} speed={3} className="font-medium" /> : n.label}
              active={topTab === "start" && section === n.id}
              onClick={() => goSection(n.id)}
            />
          ))}
        </nav>
        <div className="p-2 flex flex-col gap-0.5 border-t">
          <NavButton
            icon={Settings}
            label="Settings"
            active={topTab === "start" && section === "settings"}
            onClick={() => goSection("settings")}
          />
          <NavButton icon={Lock} label="Lock" active={false} onClick={lock} />
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-11 flex items-center gap-1 px-2 border-b shrink-0 bg-sidebar">
          <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar">
            {sessions.map((t) => (
              <ConnTab
                key={t.tabId}
                label={t.host.name}
                kind={t.kind}
                active={topTab === t.tabId}
                onSelect={() => setTopTab(t.tabId)}
                onClose={() => closeSession(t.tabId)}
                onDragStartTab={() => (dragTabId.current = t.tabId)}
                onDropTab={() => reorderTab(t.tabId)}
              />
            ))}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setPaletteOpen(true)} aria-label="New connection">
            <Plus className="size-4" />
          </Button>
        </div>

        <main className="flex-1 min-h-0 relative">
          <div className={topTab === "start" ? "absolute inset-0 overflow-y-auto" : "hidden"}>
            <div key={section} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out">
              {section === "hosts" ? (
                <HostsView onOpen={openSession} onOpenSftp={openSftp} onHostUpdated={onHostUpdated} onHostDeleted={onHostDeleted} />
              ) : section === "logs" ? (
                <LogsView />
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
            <div key={t.tabId} className={topTab === t.tabId ? "absolute inset-0" : "hidden"}>
              {t.kind === "sftp" ? (
                <SftpBrowser tabId={t.tabId} host={t.host} active={topTab === t.tabId} />
              ) : (
                <SshTerminal hostId={t.host.id} />
              )}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}

function ConnTab({
  label,
  kind,
  active,
  onSelect,
  onClose,
  onDragStartTab,
  onDropTab,
}: {
  label: string;
  kind: "terminal" | "sftp";
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStartTab: () => void;
  onDropTab: () => void;
}) {
  const Icon = kind === "sftp" ? Folder : TerminalSquare;
  const [over, setOver] = useState(false);
  return (
    <div
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStartTab();
      }}
      onDragEnd={() => setOver(false)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropTab();
      }}
      className={
        "group inline-flex items-center gap-1.5 pl-2.5 pr-1 h-8 rounded-md shrink-0 cursor-pointer text-sm whitespace-nowrap transition-colors animate-in fade-in-0 zoom-in-95 duration-200 " +
        (over ? "ring-1 ring-ring " : "") +
        (active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border dark:bg-accent dark:ring-white/10"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/40")
      }
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 grid size-5 place-items-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground transition-colors"
        aria-label="Close tab"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: typeof Server;
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "group flex items-center gap-2.5 rounded-md px-2.5 h-9 text-sm transition-colors " +
        (active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50")
      }
    >
      <Icon className="size-4 shrink-0 transition-transform group-hover:scale-110" />
      <span className="truncate flex-1 text-left">{label}</span>
      {badge}
    </button>
  );
}

function ConnectPalette({
  open,
  onOpenChange,
  onConnect,
  onConnectSftp,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConnect: (h: Host) => void;
  onConnectSftp: (h: Host) => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  useEffect(() => {
    if (open) api.hostList().then(setHosts).catch(() => setHosts([]));
  }, [open]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search a host — Enter opens a terminal, the folder icon opens files…" />
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
            <TerminalSquare className="size-4 text-muted-foreground" />
            <span className="flex flex-col min-w-0 flex-1">
              <span className="truncate">{h.name}</span>
              <span className="text-xs text-muted-foreground truncate">
                {h.username}@{h.hostname}:{h.port}
              </span>
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Open files (SFTP)"
              aria-label={`Open files on ${h.name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onConnectSftp(h);
                onOpenChange(false);
              }}
            >
              <Folder className="size-4" />
            </button>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

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

function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  fluid = false,
  bare = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "default";
  fluid?: boolean;
  bare?: boolean;
}) {
  const h = size === "sm" ? "h-7" : "h-8";
  const count = options.length;
  const activeIndex = options.findIndex((o) => o.value === value);
  return (
    <div
      className={`relative rounded-lg p-[3px] ${bare ? "" : "bg-muted"} ${fluid ? "grid w-full" : "inline-grid"}`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {activeIndex >= 0 && (
        <span
          aria-hidden
          className="absolute top-[3px] bottom-[3px] left-[3px] rounded-md bg-background ring-1 ring-border shadow-sm dark:bg-accent dark:ring-white/10 transition-transform duration-200 ease-out"
          style={{ width: `calc((100% - 6px) / ${count})`, transform: `translateX(${activeIndex * 100}%)` }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`relative z-10 ${h} px-3 rounded-md text-sm font-medium text-center whitespace-nowrap transition-colors ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const CARD = "bg-card hover:border-ring transition-colors";

function HostsView({
  onOpen,
  onOpenSftp,
  onHostUpdated,
  onHostDeleted,
}: {
  onOpen: (h: Host) => void;
  onOpenSftp: (h: Host) => void;
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
            placeholder="Search hosts…"
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
              onSftp={() => onOpenSftp(h)}
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
  onSftp,
  onEdit,
  onDelete,
}: {
  host: Host;
  onConnect: () => void;
  onSftp: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onDoubleClick={onConnect}
      className={"group relative flex flex-col gap-3 rounded-lg border p-4 select-none " + CARD}
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
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={(e) => { e.stopPropagation(); onConnect(); }}>
          Connect
        </Button>
        <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); onSftp(); }}>
          <Folder className="size-4" /> SFTP
        </Button>
      </div>
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

function cleanText(text: string): string {
  return text
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function pasteClean(
  e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  onChange: (v: string) => void,
) {
  const raw = e.clipboardData.getData("text");
  if (!raw) return;
  e.preventDefault();
  const el = e.currentTarget;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + cleanText(raw) + el.value.slice(end);
  onChange(cleanText(next));
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  const [used, setUsed] = useState(false);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className={"shrink-0 active:scale-90 " + (className ?? "")}
      aria-label={label}
      title={done ? "Copied" : label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await clipWriteText(text);
          setUsed(true);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
        }
      }}
    >
      {done ? (
        <Check className="size-3.5 text-success animate-in zoom-in-50 fade-in duration-200" />
      ) : (
        <Copy className={"size-3.5 " + (used ? "animate-in fade-in zoom-in-75 duration-200" : "")} />
      )}
    </Button>
  );
}

function sshKeyType(publicKey: string): string {
  const t = (publicKey.trim().split(/\s+/)[0] || "").toLowerCase();
  if (t === "ssh-ed25519") return "Ed25519";
  if (t === "sk-ssh-ed25519@openssh.com") return "Ed25519 (FIDO)";
  if (t === "ssh-rsa") return "RSA";
  if (t === "ssh-dss") return "DSA";
  if (t.startsWith("ecdsa-sha2-")) return "ECDSA " + t.replace("ecdsa-sha2-nistp", "P-");
  return t || "Key";
}

function SecretValueField({
  isKey,
  value,
  onChange,
}: {
  isKey: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [derived, setDerived] = useState<{ public_key: string; fingerprint: string } | null>(null);

  useEffect(() => {
    if (!isKey || !value.includes("PRIVATE KEY")) {
      setDerived(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .derivePubkey(value)
        .then((info) => alive && setDerived(info))
        .catch(() => alive && setDerived(null));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [isKey, value]);

  async function paste() {
    try {
      const t = await clipReadText();
      if (t) onChange(cleanText(t));
    } catch {
    }
  }

  if (!isKey) {
    return (
      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(cleanText(e.target.value))}
        onPaste={(e) => pasteClean(e, onChange)}
        placeholder="••••••••"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={value}
        onChange={(e) => onChange(cleanText(e.target.value))}
        onPaste={(e) => pasteClean(e, onChange)}
        placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"}
        spellCheck={false}
        data-selectable
        rows={7}
        className="w-full rounded-md border border-input bg-transparent dark:bg-input/30 px-3 py-2 text-xs font-mono leading-relaxed resize-y outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div className="flex justify-end">
        <Button type="button" size="xs" variant="ghost" onClick={paste}>
          <ClipboardPaste className="size-3.5" /> Paste from clipboard
        </Button>
      </div>
      {derived && (
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2.5 text-xs animate-in fade-in-0 duration-150">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0 w-20">Type</span>
            <span className="font-medium">{sshKeyType(derived.public_key)}</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0 w-20">Fingerprint</span>
            <span className="font-mono truncate flex-1" title={derived.fingerprint}>{derived.fingerprint}</span>
            <CopyButton text={derived.fingerprint} label="Copy fingerprint" />
          </div>
          <div className="flex items-start gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0 w-20 mt-0.5">Public key</span>
            <span className="font-mono break-all flex-1 text-muted-foreground">{derived.public_key}</span>
            <CopyButton text={derived.public_key} label="Copy public key" />
          </div>
        </div>
      )}
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
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [shaking, setShaking] = useState(false);

  const options = authKind === "key" ? keyIds : pwIds;
  const effectiveSel = options.includes(secretSel) ? secretSel : NEW_SECRET;

  function clearInvalid(key: string) {
    setInvalid((s) => {
      if (!s.has(key)) return s;
      const n = new Set(s);
      n.delete(key);
      return n;
    });
  }
  function validate(): boolean {
    const bad = new Set<string>();
    if (!name.trim()) bad.add("name");
    if (!hostname.trim()) bad.add("hostname");
    setInvalid(bad);
    if (bad.size > 0) {
      setShaking(false);
      requestAnimationFrame(() => setShaking(true));
      return false;
    }
    return true;
  }
  const shakeClass = (key: string) => (shaking && invalid.has(key) ? "animate-shake" : "");

  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, 220);
  };

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
      const user = username.trim() || "root";
      if (editing && host) {
        const updated = { ...host, name, hostname, port: safePort, username: user, auth };
        await api.hostUpdate(updated);
        onUpdated(updated);
        return updated;
      }
      return await api.hostAdd({ name, hostname, port: safePort, username: user, auth, ai_policy: "locked", ai_file_policy: "locked" });
    } catch (e) {
      setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!validate()) return;
    const h = await persist();
    if (h) {
      onSaved();
      close();
    }
  }

  async function saveAndConnect() {
    if (!validate()) return;
    const h = await persist();
    if (h) {
      onSaved();
      setOpen(false);
      setTimeout(() => onConnect(h), 220);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
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
              <Input
                value={hostname}
                onChange={(e) => {
                  setHostname(e.target.value);
                  clearInvalid("hostname");
                }}
                aria-invalid={invalid.has("hostname")}
                className={shakeClass("hostname")}
                placeholder="example.com"
              />
            </LabeledField>
          </FormSection>

          <FormSection title="General">
            <LabeledField label="Name">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearInvalid("name");
                }}
                aria-invalid={invalid.has("name")}
                className={shakeClass("name")}
                placeholder="My server"
              />
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
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  clearInvalid("username");
                }}
                aria-invalid={invalid.has("username")}
                className={shakeClass("username")}
                placeholder="root"
              />
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
                <LabeledField label={authKind === "key" ? "Private key" : "Password"}>
                  <SecretValueField isKey={authKind === "key"} value={newSecretValue} onChange={setNewSecretValue} />
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
            <Button className="w-full" onClick={save} disabled={busy}>
              {busy && <Spinner className="size-4" />}Add host
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function KeychainView() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toDelete, setToDelete] = useState<SecretMeta | null>(null);
  const [toReveal, setToReveal] = useState<SecretMeta | null>(null);
  const refresh = useCallback(async () => setSecrets(await api.secretList()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <PageHeader
        title="Keychain"
        subtitle="Keys and passwords, encrypted in the vault. Hosts reference them by ID."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Import className="size-4" /> Import
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> New credential
            </Button>
          </div>
        }
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
                className={"group relative flex items-center gap-3 rounded-lg border p-4 select-none " + CARD}
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
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setToReveal(s);
                    }}
                    aria-label="Reveal credential"
                  >
                    <Eye className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setToDelete(s);
                    }}
                    aria-label="Delete credential"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {adding && <KeychainSheet onClose={() => setAdding(false)} onSaved={refresh} />}
      {importing && <ImportVaultSheet onClose={() => setImporting(false)} onSaved={refresh} />}
      {toReveal && <RevealSecretSheet secret={toReveal} onClose={() => setToReveal(null)} />}

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

function RevealSecretSheet({ secret, onClose }: { secret: SecretMeta; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [pub, setPub] = useState<{ public_key: string; fingerprint: string } | null>(null);
  const isKey = secret.kind === "private_key";
  const close = () => {
    setOpen(false);
    setTimeout(onClose, 220);
  };

  useEffect(() => {
    let alive = true;
    api
      .secretReveal(secret.id)
      .then((v) => {
        if (!alive) return;
        setValue(v);
        if (isKey && v.includes("PRIVATE KEY")) {
          api.derivePubkey(v).then((i) => alive && setPub(i)).catch(() => {});
        }
      })
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [secret.id, isKey]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[420px] sm:max-w-[420px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle className="truncate">{secret.id}</SheetTitle>
          <SheetDescription>
            {isKey ? "Private key" : "Password"}, decrypted from the vault.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          {err ? (
            <p className="text-destructive text-sm">{err}</p>
          ) : value == null ? (
            <p className="text-muted-foreground text-sm">Decrypting…</p>
          ) : (
            <>
              <LabeledField label={isKey ? "Private key" : "Password"}>
                <div className="relative">
                  <div
                    data-selectable
                    className="w-full rounded-md border bg-muted/30 px-3 py-2 pr-9 text-xs font-mono leading-relaxed break-all whitespace-pre-wrap max-h-72 overflow-y-auto select-text"
                  >
                    {value}
                  </div>
                  <CopyButton text={value} label="Copy value" className="absolute top-1.5 right-1.5" />
                </div>
              </LabeledField>
              {pub && (
                <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2.5 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0 w-20">Type</span>
                    <span className="font-medium">{sshKeyType(pub.public_key)}</span>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0 w-20">Fingerprint</span>
                    <span className="font-mono truncate flex-1" title={pub.fingerprint}>{pub.fingerprint}</span>
                    <CopyButton text={pub.fingerprint} label="Copy fingerprint" />
                  </div>
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0 w-20 mt-0.5">Public key</span>
                    <span className="font-mono break-all flex-1 text-muted-foreground">{pub.public_key}</span>
                    <CopyButton text={pub.public_key} label="Copy public key" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function KeychainSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState<SecretKind>("password");
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, 220);
  };

  async function generate() {
    setErr("");
    setGenerating(true);
    try {
      setValue(await api.generateKey("ed25519", id || undefined));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setErr("");
    setBusy(true);
    try {
      await api.secretPut(id, kind, value);
      onSaved();
      close();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
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
            <SecretValueField isKey={kind === "private_key"} value={value} onChange={setValue} />
            {kind === "private_key" && !value && (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  No key yet? <span className="text-foreground">Ed25519</span>
                  <span className="ml-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">Recommended</span>
                </span>
                <Button type="button" size="xs" variant="secondary" onClick={generate} disabled={generating}>
                  {generating ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" />}
                  Generate
                </Button>
              </div>
            )}
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

function ImportVaultSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [path, setPath] = useState("");
  const [master, setMaster] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, 220);
  };

  useEffect(() => {
    homeDir()
      .then((h) => join(h, ".kestral", "_backup_roaming", "vault.json"))
      .then(setPath)
      .catch(() => {});
  }, []);

  async function browse() {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: "Vault", extensions: ["json"] }],
      });
      if (typeof sel === "string") setPath(sel);
    } catch {
    }
  }

  async function run() {
    setErr("");
    setNote("");
    setBusy(true);
    try {
      const ids = await api.vaultImport(path, master);
      onSaved();
      setMaster("");
      setNote(
        ids.length === 0
          ? "Nothing new. This vault already has every credential from that file."
          : `Imported ${ids.length}: ${ids.join(", ")}`,
      );
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[400px] sm:max-w-[400px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle>Import from vault file</SheetTitle>
          <SheetDescription className="sr-only">
            Copy missing credentials from another vault file into this one.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Copies credentials this vault is missing from another vault file (e.g. a backup).
            Existing ones are kept. The master password decrypts the source inside the core; secret
            values never leave it.
          </p>
          <LabeledField label="Vault file">
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="…/vault.json"
              />
              <Button variant="outline" type="button" onClick={browse}>
                Browse
              </Button>
            </div>
          </LabeledField>
          <LabeledField label="Master password of that file">
            <Input
              type="password"
              value={master}
              onChange={(e) => setMaster(e.target.value)}
              placeholder="••••••••"
            />
          </LabeledField>
          {err && <p className="text-destructive text-sm">{err}</p>}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
        <SheetFooter>
          <Button className="w-full" onClick={run} disabled={busy || !path || !master}>
            {busy && <Spinner className="size-4" />}Import
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [panel, setPanel] = useState<null | "new" | Snippet>(null);
  const [ran, setRan] = useState<{ id: string; label: string; results: RunResult[] } | null>(null);
  const [toDelete, setToDelete] = useState<Snippet | null>(null);

  const refresh = useCallback(async () => {
    setSnippets(await api.snippetList());
    setHosts(await api.hostList());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8);

  async function runSnippet(s: Snippet) {
    const targets = hosts.filter((h) => s.target_host_ids.includes(h.id));
    if (targets.length === 0) {
      setRan({ id: s.id, label: s.label, results: [] });
      return;
    }
    setRan({
      id: s.id,
      label: s.label,
      results: targets.map((h) => ({ hostId: h.id, hostName: h.name, pending: true })),
    });
    await Promise.all(
      targets.map(async (h) => {
        const done = (r: Partial<RunResult>) =>
          setRan((cur) =>
            cur == null
              ? cur
              : {
                  ...cur,
                  results: cur.results.map((x) =>
                    x.hostId === h.id ? { ...x, pending: false, ...r } : x,
                  ),
                },
          );
        try {
          done({ out: await api.runCommandUi(h.id, s.script, true) });
        } catch (e) {
          done({ error: errText(e) });
        }
      }),
    );
  }

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <PageHeader
        title="Scripts"
        subtitle="Saved scripts, scoped to the hosts you choose."
        action={<Button onClick={() => setPanel("new")}><Plus className="size-4" /> New script</Button>}
      />

      {snippets.length === 0 ? (
        <EmptyState icon={<Code className="size-6" />} title="No scripts yet" hint="Save scripts you run often and scope them to hosts." />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
          {snippets.map((s) => (
            <div
              key={s.id}
              onDoubleClick={() => runSnippet(s)}
              className={"group relative rounded-lg border p-4 cursor-pointer select-none " + CARD}
            >
              <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); runSnippet(s); }} aria-label="Run script">
                  <Play className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); setPanel(s); }} aria-label="Edit script">
                  <Pencil className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); setToDelete(s); }} aria-label="Delete script">
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="font-medium truncate text-sm pr-20">{s.label}</div>
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

      {ran && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 border-t pt-4">
            <span className="text-sm font-medium">Output · {ran.label}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              onClick={() => setRan(null)}
              aria-label="Clear output"
            >
              <X className="size-4" />
            </Button>
          </div>
          {ran.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No target hosts on this script. Open it and pick where it should run.
            </p>
          ) : (
            ran.results.map((r) => <RunResultBlock key={r.hostId} result={r} />)
          )}
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
          title="Delete script"
          message={`Delete "${toDelete.label}"?`}
          onConfirm={async () => {
            try {
              await api.snippetDelete(toDelete.id);
            } finally {
              setRan((cur) => (cur?.id === toDelete.id ? null : cur));
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
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setTimeout(onClose, 220);
  };

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
      close();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        style={{ top: "2.75rem", bottom: "auto", height: "calc(100svh - 2.75rem)" }}
        className="w-[400px] sm:max-w-[400px] flex flex-col gap-0 p-0"
      >
        <SheetHeader>
          <SheetTitle>{editing ? "Edit script" : "New script"}</SheetTitle>
          <SheetDescription className="sr-only">Configure the script.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">
          <FormSection title="Script">
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
            {editing ? "Save" : "Save script"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

type RunResult = {
  hostId: string;
  hostName: string;
  pending?: boolean;
  out?: CommandOutput;
  error?: string;
};

function TerminalOutput({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { termTheme, termColors } = usePrefs();
  const rows = Math.min(24, Math.max(3, text.split(String.fromCharCode(10)).length));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      theme: terminalTheme(termTheme, termColors),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
    }
    term.write(text);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, [text, termTheme, termColors]);

  return <div ref={ref} className="overflow-hidden rounded" style={{ height: rows * 16 + 8 }} />;
}

function RunResultBlock({ result }: { result: RunResult }) {
  const failed =
    result.error != null ||
    (result.out != null && result.out.exit_status !== 0 && result.out.exit_status !== null);
  const label = result.pending
    ? "running…"
    : result.error
      ? "failed"
      : `exit ${result.out?.exit_status ?? "?"}`;

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium truncate">{result.hostName}</span>
        <span
          className={
            "ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs " +
            (result.pending
              ? "bg-muted text-muted-foreground"
              : failed
                ? "bg-destructive/15 text-destructive"
                : "bg-success/15 text-success")
          }
        >
          {label}
        </span>
      </div>
      <div className="px-3 py-2">
        {result.pending && <p className="text-xs text-muted-foreground">waiting for the host…</p>}
        {result.error && <p className="text-xs text-destructive">{result.error}</p>}
        {result.out?.stdout && <TerminalOutput text={result.out.stdout} />}
        {result.out?.stderr && (
          <pre
            className={
              "mt-2 max-h-32 overflow-auto rounded p-2 text-xs font-mono whitespace-pre-wrap " +
              (failed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")
            }
          >
            {result.out.stderr}
          </pre>
        )}
        {result.out && !result.out.stdout && !result.out.stderr && (
          <p className="text-xs text-muted-foreground">No output.</p>
        )}
      </div>
    </div>
  );
}

function aiDecisionLabel(d: string): string {
  switch (d) {
    case "allowed":
      return "auto";
    case "approved":
      return "you approved";
    case "denied":
      return "refused";
    case "config":
      return "config change";
    default:
      return d;
  }
}

function LogsView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const refresh = useCallback(async () => setEntries(await api.auditList()), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <PageHeader title="Logs" subtitle="What you ran and what the AI did, side by side, with the result." />

      {entries.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-6" />} title="No activity yet" hint="Commands you run and AI actions appear here." />
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Time</TableHead>
                <TableHead className="w-36">By</TableHead>
                <TableHead className="w-40">Host</TableHead>
                <TableHead>Command</TableHead>
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
                    <TableCell>
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        {e.decision === "user" ? (
                          <Badge variant="info">You</Badge>
                        ) : (
                          <>
                            <Badge variant="warning">AI</Badge>
                            <span className="text-xs text-muted-foreground">{aiDecisionLabel(e.decision)}</span>
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="truncate">{e.host_name}</TableCell>
                    <TableCell className="font-mono text-xs">{e.command}</TableCell>
                    <TableCell>
                      {e.decision === "denied" ? (
                        <Badge variant="secondary">refused</Badge>
                      ) : (
                        <Badge variant={e.success ? "success" : "destructive"}>
                          {e.success ? "ok" : "error"}
                          {e.exit_status != null ? ` (${e.exit_status})` : ""}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function McpView() {
  const { aiMinutes, setAiMinutes } = usePrefs();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [caps, setCaps] = useState<AiCaps | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [connectMsg, setConnectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [skillOk, setSkillOk] = useState<boolean | null>(null);
  const [regs, setRegs] = useState<api.Registration[] | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await api.aiStatus());
    setHosts(await api.hostList());
  }, []);
  useEffect(() => {
    refresh();
    api.aiCaps().then(setCaps);
    api.skillInstalled().then(setSkillOk).catch(() => {});
    api.mcpListRegistrations().then(setRegs).catch(() => setRegs([]));
    const t = setInterval(() => api.aiStatus().then(setStatus), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function setCap(key: keyof AiCaps, val: boolean) {
    if (!caps) return;
    const next = { ...caps, [key]: val };
    setCaps(next);
    await api.aiSetCaps(next);
  }

  const active = status?.active ?? false;
  const mcpReg = regs?.find((r) => r.is_this_app) ?? null;

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

  async function connectClaudeCode() {
    setConnecting(true);
    setConnectMsg(null);
    try {
      const r = await api.mcpConnectClaudeCode("kestral");
      setConnectMsg({ ok: r.ok, text: r.message });
      refreshRegs();
    } catch (e) {
      setConnectMsg({ ok: false, text: errText(e) });
    } finally {
      setConnecting(false);
    }
  }

  async function installSkillFiles() {
    setInstalling(true);
    setInstallMsg(null);
    try {
      const r = await api.installSkill();
      setSkillOk(true);
      setInstallMsg({ ok: true, text: `${r.message}\nRuntime: ${r.runtime}\n${r.skill_path}` });
    } catch (e) {
      setInstallMsg({ ok: false, text: errText(e) });
    } finally {
      setInstalling(false);
    }
  }

  async function removeSkill() {
    setInstalling(true);
    setInstallMsg(null);
    try {
      const msg = await api.uninstallSkill();
      setSkillOk(false);
      setInstallMsg({ ok: true, text: msg });
    } catch (e) {
      setInstallMsg({ ok: false, text: errText(e) });
    } finally {
      setInstalling(false);
    }
  }

  async function refreshRegs() {
    try {
      setRegs(await api.mcpListRegistrations());
    } catch {
      setRegs([]);
    }
  }

  async function removeReg(name: string) {
    setRegs((cur) => (cur ?? []).filter((r) => r.name !== name));
    try {
      await api.mcpRemoveRegistration(name);
    } finally {
      refreshRegs();
    }
  }

  async function rotateToken() {
    setRotating(true);
    setConnectMsg(null);
    try {
      const r = await api.mcpRotateToken("kestral");
      setConnectMsg({ ok: true, text: r.message });
      refreshRegs();
    } catch (e) {
      setConnectMsg({ ok: false, text: errText(e) });
    } finally {
      setRotating(false);
    }
  }

  async function setAll(policy: AiPolicy) {
    await Promise.all(
      hosts.flatMap((h) => [api.hostSetPolicy(h.id, policy), api.hostSetFilePolicy(h.id, policy)]),
    );
    refresh();
  }

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">AI access</h2>
        <p className="text-sm text-muted-foreground">
          Optional. Lets an AI run commands through Kestral's MCP server, with your approval. Off by default.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col">
          <div className="flex items-center gap-4">
            <Switch checked={active} onCheckedChange={toggle} aria-label="AI access" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">
                {active ? <ShinyText text="AI access" className="font-medium" speed={3} /> : "AI access"}
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
          <div className={"grid transition-[grid-template-rows] duration-200 ease-out " + (active ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}>
            <div className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-t pt-4 mt-4">
                <span className="text-sm text-muted-foreground">Turn on for</span>
                <Segmented
                  value={String(aiMinutes)}
                  onChange={(v) => setAiMinutes(Number(v))}
                  size="sm"
                  options={DURATIONS.map((d) => ({ value: d.id, label: d.label }))}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI clients</CardTitle>
          <CardDescription>
            Two methods for Claude to reach Kestral. Set up both, Claude picks whichever is
            available.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Skill</p>
                  <span
                    className={
                      "text-xs rounded px-1.5 py-0.5 " +
                      (skillOk ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")
                    }
                  >
                    {skillOk === null ? "checking…" : skillOk ? "installed" : "not installed"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  For chats that are already open. A running chat cannot load new tools, so this is
                  the only thing that reaches it.
                </p>
              </div>
              <div className="flex w-48 shrink-0 justify-end">
                {skillOk === null ? (
                  <Button size="sm" className="w-full" variant="secondary" disabled>
                    <Spinner className="size-4" />Checking…
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    variant={skillOk ? "secondary" : "default"}
                    onClick={skillOk ? removeSkill : installSkillFiles}
                    disabled={installing}
                  >
                    {installing && <Spinner className="size-4" />}
                    {skillOk ? "Remove" : "Install"}
                  </Button>
                )}
              </div>
            </div>
            {installMsg && (
              <p
                className={
                  "text-xs whitespace-pre-wrap break-all " +
                  (installMsg.ok ? "text-muted-foreground" : "text-destructive")
                }
              >
                {installMsg.text}
              </p>
            )}
          </div>

          <div className="border-t pt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">MCP</p>
                <p className="text-sm text-muted-foreground">
                  The better method: real tools with checked arguments. Only chats started after
                  connecting can see it.
                </p>
              </div>
              <div className="flex w-48 shrink-0 justify-end">
                {regs === null ? (
                  <Button size="sm" className="w-full" variant="secondary" disabled>
                    <Spinner className="size-4" />Checking…
                  </Button>
                ) : mcpReg && mcpReg.connected ? (
                  <Button
                    size="sm"
                    className="w-full"
                    variant="secondary"
                    onClick={rotateToken}
                    disabled={rotating}
                  >
                    {rotating && <Spinner className="size-4" />}Rotate token
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={connectClaudeCode}
                    disabled={connecting}
                  >
                    {connecting && <Spinner className="size-4" />}
                    {mcpReg ? "Reconnect" : "Connect"}
                  </Button>
                )}
              </div>
            </div>
            {connectMsg && (
              <p
                className={
                  "text-xs whitespace-pre-wrap " +
                  (connectMsg.ok ? "text-muted-foreground" : "text-destructive")
                }
              >
                {connectMsg.text}
              </p>
            )}

            {regs === null ? (
              <p className="text-xs text-muted-foreground">checking…</p>
            ) : regs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing registered yet. Use “Connect Claude Code” above.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {regs.map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <span
                      className={
                        "size-2 rounded-full shrink-0 " +
                        (r.connected ? "bg-success" : "bg-destructive")
                      }
                      aria-hidden
                    />
                    <span className="font-medium truncate">{r.name}</span>
                    {r.is_this_app && (
                      <span className="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">
                        this app
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground truncate flex-1">{r.url}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => removeReg(r.name)}
                      aria-label={`Remove ${r.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground border-t pt-4">
            Same rules either way: AI access must be on, locked hosts are refused, hosts set to ask
            need your approval, everything is logged.
          </p>
        </CardContent>
      </Card>

      {caps && (
        <Card>
          <CardHeader>
            <CardTitle>What the AI may do</CardTitle>
            <CardDescription>
              Separate from the per-host policy below. Turn off listing and the AI cannot enumerate, it
              only acts on hosts you name explicitly. Managing is off by default.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <SettingRow label="List hosts" hint="Let the AI see all your hosts. Off: you must name a host.">
              <Switch checked={caps.list_hosts} onCheckedChange={(v) => setCap("list_hosts", v)} aria-label="List hosts" />
            </SettingRow>
            <SettingRow label="List scripts" hint="Let the AI read your saved scripts.">
              <Switch checked={caps.list_snippets} onCheckedChange={(v) => setCap("list_snippets", v)} aria-label="List scripts" />
            </SettingRow>
            <SettingRow label="List credentials" hint="Only ids and kinds, never the secret values.">
              <Switch checked={caps.list_secrets} onCheckedChange={(v) => setCap("list_secrets", v)} aria-label="List credentials" />
            </SettingRow>
            <SettingRow label="Read audit log" hint="Let the AI read its own action history.">
              <Switch checked={caps.audit_log} onCheckedChange={(v) => setCap("audit_log", v)} aria-label="Read audit log" />
            </SettingRow>
            <div className="border-t pt-4 flex flex-col gap-4">
              <SettingRow label="Create and change hosts" hint="Let the AI add or edit hosts. It never sees secret values.">
                <Switch checked={caps.manage_hosts} onCheckedChange={(v) => setCap("manage_hosts", v)} aria-label="Manage hosts" />
              </SettingRow>
              <SettingRow
              label="Create, change and delete scripts"
              hint="Let the AI manage your saved scripts. Deleting is included and cannot be undone."
            >
                <Switch checked={caps.manage_snippets} onCheckedChange={(v) => setCap("manage_snippets", v)} aria-label="Manage scripts" />
              </SettingRow>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Per-host permission</CardTitle>
          <CardDescription>
            Commands and files (SFTP) are gated separately. Blocked: AI cannot touch it. Ask: every
            request needs approval. Free: AI may act freely.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {hosts.length > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Set all:</span>
              <Button size="xs" variant="outline" onClick={() => setAll("locked")}>Block</Button>
              <Button size="xs" variant="outline" onClick={() => setAll("confirm")}>Ask</Button>
              <Button size="xs" variant="outline" onClick={() => setAll("free")}>Free</Button>
            </div>
          )}
          {hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hosts yet.</p>
          ) : (
            hosts.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="text-sm truncate">{h.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{h.username}@{h.hostname}</div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">Commands</span>
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
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">Files</span>
                    <Segmented
                      value={h.ai_file_policy}
                      size="sm"
                      onChange={async (p) => {
                        await api.hostSetFilePolicy(h.id, p);
                        refresh();
                      }}
                      options={POLICIES.map((p) => ({ value: p, label: POLICY_LABEL[p] }))}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

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
          <span style={{ color: theme.green }}>user@kestral</span>
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
  const {
    theme,
    setTheme,
    animScale,
    setAnimScale,
    termTheme,
    setTermTheme,
    termColors,
    setTermColors,
    aiMinutes,
    setAiMinutes,
    aiAutoEnable,
    setAiAutoEnable,
    sftpShowHidden,
    setSftpShowHidden,
    sftpAutoRefresh,
    setSftpAutoRefresh,
  } = usePrefs();
  const termIds = Object.keys(TERMINAL_THEMES);
  const preview = terminalTheme(termTheme, termColors);

  return (
    <div className="px-6 pt-5 pb-12 flex flex-col gap-5">
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
            <div className="w-64">
              <Segmented<Theme>
                value={theme}
                onChange={setTheme}
                size="sm"
                fluid
                options={THEMES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
              />
            </div>
          </SettingRow>
          <SettingRow label="Animations" hint="Speed of UI motion.">
            <div className="w-64">
              <Segmented
                value={animScale >= 1.2 ? "slow" : animScale <= 0.8 ? "fast" : "normal"}
                onChange={(v) => setAnimScale(v === "slow" ? 1.4 : v === "fast" ? 0.6 : 1)}
                size="sm"
                fluid
                options={[
                  { value: "slow", label: "Slow" },
                  { value: "normal", label: "Normal" },
                  { value: "fast", label: "Fast" },
                ]}
              />
            </div>
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Terminal</CardTitle>
          <CardDescription>Color scheme of the terminal emulator. Applies to all sessions.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SettingRow label="Colors" hint="Render ANSI colors. Off makes the terminal single-colored.">
            <Switch checked={termColors} onCheckedChange={setTermColors} aria-label="Terminal colors" />
          </SettingRow>
          <SettingRow label="Color scheme" hint="Also tints the terminal frame.">
            <Select value={termTheme} onValueChange={setTermTheme}>
              <SelectTrigger className="w-64">
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
          <CardTitle>SFTP</CardTitle>
          <CardDescription>File browser behaviour, applied to all SFTP sessions.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SettingRow label="Show hidden files" hint="Files and folders whose name starts with a dot.">
            <Switch checked={sftpShowHidden} onCheckedChange={setSftpShowHidden} aria-label="Show hidden files" />
          </SettingRow>
          <SettingRow label="Auto-refresh" hint="Re-read the current folder periodically.">
            <Switch checked={sftpAutoRefresh} onCheckedChange={setSftpAutoRefresh} aria-label="Auto-refresh" />
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI access</CardTitle>
          <CardDescription>When AI access switches on, and how long it stays on.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SettingRow
            label="Turn on after unlocking"
            hint="Enables AI access automatically once you unlock. The auto-off timer still applies."
          >
            <Switch
              checked={aiAutoEnable}
              onCheckedChange={setAiAutoEnable}
              aria-label="Enable AI access after unlocking"
            />
          </SettingRow>
          <SettingRow label="Default duration" hint="Preset for the auto-off timer.">
            <div className="w-64">
              <Segmented
                value={String(aiMinutes)}
                onChange={(v) => setAiMinutes(Number(v))}
                size="sm"
                fluid
                options={DURATIONS.map((d) => ({ value: d.id, label: d.label }))}
              />
            </div>
          </SettingRow>
        </CardContent>
      </Card>

      <ChangePasswordCard />
    </div>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  const reset = () => {
    setErr("");
    setOk(false);
  };
  const canSave = !!current && !!next && next === confirm && !busy;

  async function save() {
    setErr("");
    setOk(false);
    if (next !== confirm) {
      setErr("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api.vaultChangeMaster(current, next);
      setOk(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>
          Change the master password. It unlocks the vault and encrypts all local data, including
          host names and IP addresses.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex max-w-sm flex-col gap-4">
          <LabeledField label="Current password">
            <Input
              type="password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                reset();
              }}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </LabeledField>
          <LabeledField label="New password">
            <Input
              type="password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                reset();
              }}
              placeholder="New master password"
              autoComplete="new-password"
            />
          </LabeledField>
          <LabeledField label="Confirm new password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                reset();
              }}
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </LabeledField>
          {err && <p className="text-sm text-destructive">{err}</p>}
          {ok && <p className="text-sm text-success">Master password changed.</p>}
        </div>

        <div className="border-t pt-4">
          <Button onClick={save} disabled={!canSave}>
            {busy && <Spinner className="size-4" />}Change password
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

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
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-primary/15 text-primary grid place-items-center shrink-0">
              <Cpu className="size-5" />
            </div>
            <div className="min-w-0">
              <AlertDialogTitle>AI wants to run a command</AlertDialogTitle>
              <AlertDialogDescription>
                On <span className="font-medium text-foreground">{req.host_name}</span>. Review it before you allow it.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <pre className="overflow-auto max-h-52 rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all" data-selectable>
          {req.command}
        </pre>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer(req.id, false)}>Deny</AlertDialogCancel>
          <AlertDialogAction onClick={() => onAnswer(req.id, true)} className="bg-primary">
            Approve &amp; run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
