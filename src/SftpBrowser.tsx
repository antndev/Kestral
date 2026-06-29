import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  RefreshCw,
  Upload,
  Download,
  FolderPlus,
  Trash2,
  Folder,
  File as FileIcon,
  CircleAlert,
  Link2,
  Pencil,
  SquarePen,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import * as api from "./api";
import type { FileEntry, Host } from "./api";
import { usePrefs } from "./lib/prefs";

function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
function parentPath(p: string): string {
  const t = p.replace(/\/+$/, "");
  if (t === "") return "/";
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}
function joinLocal(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, "") + "/" + name;
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(mtime: number | null): string {
  if (!mtime) return "—";
  return new Date(mtime * 1000).toLocaleString();
}

/** Termius-artiger SFTP-Dateibrowser fuer einen Host. Eigene SFTP-Sitzung im Kern
 *  (per tabId), unabhaengig vom KI-Zugriff. */
export function SftpBrowser({ tabId, host }: { tabId: string; host: Host }) {
  const { sftpShowHidden, sftpAutoRefresh } = usePrefs();
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [phase, setPhase] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState(0);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string; original: string } | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);

  const visible = sftpShowHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  const load = useCallback(
    async (path: string) => {
      setBusy(true);
      setError("");
      try {
        const list = await api.sftpList(tabId, path);
        setEntries(list);
        setCwd(path);
        setPendingDelete(null);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [tabId],
  );

  // Verbindung beim Mount (und bei Reconnect ueber gen).
  useEffect(() => {
    let alive = true;
    setPhase("connecting");
    setError("");
    api
      .sftpOpen(tabId, host.id)
      .then(async (home) => {
        if (!alive) return;
        setPhase("ready");
        await load(home || "/");
      })
      .catch((e) => {
        if (alive) {
          setError(errText(e));
          setPhase("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [tabId, host.id, gen, load]);

  // Sitzung beim Schliessen des Tabs beenden.
  useEffect(() => () => void api.sftpClose(tabId), [tabId]);

  // Automatisches Aktualisieren des aktuellen Ordners, pausiert bei Interaktion.
  const liveRef = useRef({ busy, renaming, newFolder, pendingDelete, selSize: selected.size, cwd });
  liveRef.current = { busy, renaming, newFolder, pendingDelete, selSize: selected.size, cwd };
  useEffect(() => {
    if (!sftpAutoRefresh || phase !== "ready") return;
    const t = setInterval(() => {
      const s = liveRef.current;
      if (!s.busy && !s.renaming && s.newFolder === null && s.pendingDelete === null && s.selSize === 0) {
        load(s.cwd);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [sftpAutoRefresh, phase, load]);

  function navigate(path: string) {
    setSelected(new Set());
    setBatchConfirm(false);
    load(path);
  }
  function toggleSelect(path: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected((s) => {
      const all = visible.length > 0 && visible.every((e) => s.has(e.path));
      return all ? new Set() : new Set(visible.map((e) => e.path));
    });
  }

  async function upload() {
    try {
      const picked = await openDialog({ multiple: false, title: "Upload file" });
      if (!picked || typeof picked !== "string") return;
      const name = picked.replace(/\\/g, "/").split("/").pop() || "upload";
      setBusy(true);
      setNote("");
      const n = await api.sftpUpload(tabId, picked, joinPath(cwd, name));
      setNote(`Uploaded ${name} (${fmtSize(n)})`);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(entry: FileEntry) {
    try {
      const dest = await saveDialog({ defaultPath: entry.name, title: "Save as" });
      if (!dest) return;
      setBusy(true);
      setNote("");
      const n = await api.sftpDownload(tabId, entry.path, dest);
      setNote(`Downloaded ${entry.name} (${fmtSize(n)})`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function batchDownload() {
    const files = visible.filter((e) => selected.has(e.path) && !e.is_dir);
    if (files.length === 0) return;
    try {
      const dir = await openDialog({ directory: true, title: "Download selected to folder" });
      if (!dir || typeof dir !== "string") return;
      setBusy(true);
      setNote("");
      let bytes = 0;
      for (const f of files) bytes += await api.sftpDownload(tabId, f.path, joinLocal(dir, f.name));
      setNote(`Downloaded ${files.length} files (${fmtSize(bytes)})`);
      setSelected(new Set());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function batchDelete() {
    const items = visible.filter((e) => selected.has(e.path));
    try {
      setBusy(true);
      for (const it of items) await api.sftpRemove(tabId, it.path, it.is_dir);
      setBatchConfirm(false);
      setSelected(new Set());
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const name = (newFolder || "").trim();
    if (!name) {
      setNewFolder(null);
      return;
    }
    try {
      setBusy(true);
      await api.sftpMkdir(tabId, joinPath(cwd, name));
      setNewFolder(null);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: FileEntry) {
    try {
      setBusy(true);
      await api.sftpRemove(tabId, entry.path, entry.is_dir);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRename(entry: FileEntry) {
    const name = (renaming?.value || "").trim();
    if (!name || name === entry.name) {
      setRenaming(null);
      return;
    }
    try {
      setBusy(true);
      await api.sftpRename(tabId, entry.path, joinPath(cwd, name));
      setRenaming(null);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // --- Eingebauter Editor (Inhalt in den Speicher laden, beim Speichern zurueck) ---
  async function openEditor(entry: FileEntry) {
    setBusy(true);
    setError("");
    try {
      const content = await api.sftpReadText(tabId, entry.path);
      setEditing({ path: entry.path, content, original: content });
      setDiscardArmed(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveEditor() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api.sftpWriteText(tabId, editing.path, editing.content);
      setEditing({ ...editing, original: editing.content });
      setNote(`Saved ${editing.path.split("/").pop()}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  function closeEditor() {
    if (editing && editing.content !== editing.original && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    setEditing(null);
    setDiscardArmed(false);
    setError("");
  }

  if (phase === "connecting") {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-3 text-sm">
          <Spinner className="size-4" /> Connecting to {host.name}…
        </div>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <div className="size-12 rounded-full bg-destructive/15 text-destructive flex items-center justify-center">
            <CircleAlert className="size-6" />
          </div>
          <div className="text-sm text-muted-foreground max-w-sm break-words">{error}</div>
          <Button size="sm" variant="secondary" onClick={() => setGen((g) => g + 1)}>
            Reconnect
          </Button>
        </div>
      </div>
    );
  }

  // Editor-Modus: belegt die ganze Flaeche, Inhalt liegt nur im Speicher.
  if (editing) {
    const dirty = editing.content !== editing.original;
    return (
      <div className="h-full w-full flex flex-col">
        <div className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
          <FileIcon className="size-4 text-muted-foreground shrink-0" />
          <span className="flex-1 min-w-0 text-sm font-mono truncate" title={editing.path}>
            {editing.path}
            {dirty ? " •" : ""}
          </span>
          {discardArmed ? (
            <>
              <span className="text-xs text-muted-foreground">Discard changes?</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDiscardArmed(false);
                  setEditing(null);
                  setError("");
                }}
              >
                Discard
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDiscardArmed(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={closeEditor} disabled={busy}>
                Close
              </Button>
              <Button variant="secondary" size="sm" onClick={saveEditor} disabled={busy || !dirty}>
                {busy && <Spinner className="size-4" />} Save
              </Button>
            </>
          )}
        </div>
        {error && <div className="px-3 py-1.5 text-xs border-b text-destructive shrink-0">{error}</div>}
        <textarea
          value={editing.content}
          onChange={(ev) => setEditing({ ...editing, content: ev.target.value })}
          spellCheck={false}
          data-selectable
          className="flex-1 min-h-0 w-full resize-none bg-background text-foreground font-mono text-sm leading-relaxed p-3 outline-none"
        />
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 h-11 border-b shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(parentPath(cwd))} disabled={busy || cwd === "/"} aria-label="Up">
          <ArrowUp className="size-4" />
        </Button>
        <div className="flex-1 min-w-0 px-2 text-sm font-mono truncate text-muted-foreground" title={cwd}>
          {cwd || "/"}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => load(cwd)} disabled={busy} aria-label="Refresh">
          <RefreshCw className={"size-4 " + (busy ? "animate-spin" : "")} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setNewFolder("")} disabled={busy} aria-label="New folder">
          <FolderPlus className="size-4" />
        </Button>
        <Button variant="secondary" size="sm" onClick={upload} disabled={busy}>
          <Upload className="size-4" /> Upload
        </Button>
      </div>

      {/* Feste Kopfzeile: links "alle auswaehlen", rechts Spalten oder Batch-Aktionen.
          Immer vorhanden, damit das Auswaehlen nichts verschiebt. */}
      <div className="flex items-center gap-3 px-3 h-8 border-b shrink-0 bg-muted/30">
        <Checkbox
          checked={visible.length > 0 && visible.every((e) => selected.has(e.path))}
          onCheckedChange={toggleSelectAll}
          aria-label="Select all"
          className="shrink-0"
        />
        {selected.size > 0 ? (
          <>
            <span className="text-sm font-medium flex-1">{selected.size} selected</span>
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={batchDownload} disabled={busy}>
              <Download className="size-3.5" /> Download
            </Button>
            {batchConfirm ? (
              <>
                <span className="text-xs text-muted-foreground">Delete {selected.size}?</span>
                <Button variant="ghost" size="icon-sm" className="size-6" onClick={batchDelete} disabled={busy} aria-label="Confirm delete">
                  <Check className="size-3.5 text-destructive" />
                </Button>
                <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => setBatchConfirm(false)} aria-label="Cancel">
                  <X className="size-3.5" />
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setBatchConfirm(true)} disabled={busy}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground flex-1">
            {visible.length} {visible.length === 1 ? "item" : "items"}
          </span>
        )}
      </div>

      {/* New-folder input */}
      {newFolder !== null && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 shrink-0">
          <FolderPlus className="size-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createFolder();
              if (e.key === "Escape") setNewFolder(null);
            }}
            placeholder="Folder name"
            className="flex-1 bg-transparent outline-none text-sm"
          />
          <Button size="sm" variant="ghost" onClick={createFolder}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => setNewFolder(null)}>Cancel</Button>
        </div>
      )}

      {(error || note) && (
        <div className={"px-3 py-1.5 text-xs border-b shrink-0 " + (error ? "text-destructive" : "text-muted-foreground")}>
          {error || note}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Empty folder</div>
        ) : (
          <div className="flex flex-col">
            {visible.map((e) => {
              const rowActive = renaming?.path === e.path || pendingDelete === e.path;
              return (
                <div
                  key={e.path}
                  className="group relative flex items-center gap-3 px-3 h-9 border-b border-border/50 hover:bg-muted text-sm"
                >
                  <Checkbox
                    checked={selected.has(e.path)}
                    onCheckedChange={() => toggleSelect(e.path)}
                    aria-label="Select"
                    className="shrink-0"
                  />
                  {renaming?.path === e.path ? (
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {e.is_dir ? (
                        <Folder className="size-4 shrink-0 text-blue-400" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <input
                        autoFocus
                        value={renaming.value}
                        onChange={(ev) => setRenaming({ path: e.path, value: ev.target.value })}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") doRename(e);
                          if (ev.key === "Escape") setRenaming(null);
                        }}
                        className="flex-1 min-w-0 bg-transparent outline-none text-sm border-b border-ring"
                      />
                    </div>
                  ) : (
                    <button
                      className="flex items-center gap-2 min-w-0 flex-1 text-left"
                      onDoubleClick={() => (e.is_dir ? navigate(e.path) : openEditor(e))}
                      onClick={() => e.is_dir && navigate(e.path)}
                    >
                      {e.is_dir ? (
                        <Folder className="size-4 shrink-0 text-blue-400" />
                      ) : e.is_symlink ? (
                        <Link2 className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className={"truncate " + (e.name.startsWith(".") ? "text-muted-foreground" : e.is_dir ? "text-foreground" : "")}>
                        {e.name}
                      </span>
                    </button>
                  )}
                  <span className="w-20 text-right text-xs text-muted-foreground tabular-nums shrink-0">
                    {e.is_dir ? "" : fmtSize(e.size)}
                  </span>
                  <span className="w-40 text-right text-xs text-muted-foreground truncate shrink-0 hidden md:block">
                    {fmtTime(e.mtime)}
                  </span>
                  {/* Aktionen als Overlay rechts, damit sie die Spalten nicht verschieben. */}
                  <div
                    className={
                      "absolute right-1 inset-y-0 flex items-center gap-0.5 bg-muted pl-4 transition-opacity " +
                      (rowActive ? "opacity-100" : "opacity-0 group-hover:opacity-100")
                    }
                  >
                    {renaming?.path === e.path ? (
                      <>
                        <Button variant="ghost" size="icon-sm" onClick={() => doRename(e)} aria-label="Confirm rename">
                          <Check className="size-4 text-foreground" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setRenaming(null)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </>
                    ) : pendingDelete === e.path ? (
                      <>
                        <Button variant="ghost" size="icon-sm" onClick={() => remove(e)} aria-label="Confirm delete">
                          <Check className="size-4 text-destructive" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(null)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        {!e.is_dir && (
                          <Button variant="ghost" size="icon-sm" onClick={() => openEditor(e)} aria-label="Edit" disabled={busy}>
                            <SquarePen className="size-4" />
                          </Button>
                        )}
                        {!e.is_dir && (
                          <Button variant="ghost" size="icon-sm" onClick={() => download(e)} aria-label="Download">
                            <Download className="size-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon-sm" onClick={() => setRenaming({ path: e.path, value: e.name })} aria-label="Rename">
                          <Pencil className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(e.path)} aria-label="Delete">
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
