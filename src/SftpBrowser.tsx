import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { tempDir, join } from "@tauri-apps/api/path";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  ArrowUp,
  RefreshCw,
  Upload,
  Download,
  FolderPlus,
  FilePlus,
  ChevronDown,
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

export function SftpBrowser({ tabId, host, active }: { tabId: string; host: Host; active: boolean }) {
  const { sftpShowHidden, sftpAutoRefresh } = usePrefs();
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [phase, setPhase] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gen, setGen] = useState(0);
  const [creating, setCreating] = useState<{ kind: "file" | "folder"; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ entry: FileEntry; recursive: boolean; count: number } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string; original: string } | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);

  const visible = sftpShowHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const activeRef = useRef(active);
  activeRef.current = active;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    setPathDraft(cwd);
  }, [cwd]);

  useEffect(() => {
    setAnchor(null);
  }, [entries, sftpShowHidden]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setCtxMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu]);

  const reqRef = useRef(0);
  const load = useCallback(
    async (path: string) => {
      const myReq = ++reqRef.current;
      setBusy(true);
      setError("");
      try {
        const list = await api.sftpList(tabId, path);
        if (myReq !== reqRef.current) return;
        setEntries(list);
        setCwd(path);
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const keep = new Set(list.map((e) => e.path));
          const next = new Set([...prev].filter((p) => keep.has(p)));
          return next.size === prev.size ? prev : next;
        });
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setError(errText(e));
      } finally {
        if (myReq === reqRef.current) setBusy(false);
      }
    },
    [tabId],
  );

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

  useEffect(() => () => void api.sftpClose(tabId), [tabId]);

  useEffect(() => {
    let alive = true;
    let off: undefined | (() => void);
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!activeRef.current || editingRef.current) return;
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(true);
        } else if (p.type === "leave") {
          setDragOver(false);
        } else if (p.type === "drop") {
          setDragOver(false);
          if (p.paths.length) void uploadPaths(p.paths);
        }
      })
      .then((f) => {
        if (alive) off = f;
        else f();
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const liveRef = useRef({ busy, renaming, creating, confirmDelete, editing, selSize: selected.size, cwd });
  liveRef.current = { busy, renaming, creating, confirmDelete, editing, selSize: selected.size, cwd };
  useEffect(() => {
    if (!sftpAutoRefresh || phase !== "ready") return;
    const t = setInterval(() => {
      const s = liveRef.current;
      if (
        !s.busy &&
        !s.renaming &&
        s.creating === null &&
        s.confirmDelete === null &&
        s.editing === null &&
        s.selSize === 0
      ) {
        load(s.cwd);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [sftpAutoRefresh, phase, load]);

  function navigate(path: string) {
    setSelected(new Set());
    setBatchConfirm(false);
    setAnchor(null);
    load(path);
  }
  function selectAt(index: number, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor !== null) {
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = a; i <= b; i++) {
          const v = visible[i];
          if (v) next.add(v.path);
        }
      } else {
        const v = visible[index];
        if (!v) return prev;
        if (next.has(v.path)) next.delete(v.path);
        else next.add(v.path);
      }
      return next;
    });
    if (!shift) setAnchor(index);
  }
  function toggleSelectAll() {
    setSelected((s) => {
      const all = visible.length > 0 && visible.every((e) => s.has(e.path));
      return all ? new Set() : new Set(visible.map((e) => e.path));
    });
    setAnchor(null);
  }

  async function uploadPaths(paths: string[]) {
    if (!paths.length) return;
    try {
      setBusy(true);
      setError("");
      setNote("");
      let bytes = 0;
      for (const p of paths) {
        const name = p.replace(/\\/g, "/").split("/").pop() || "upload";
        bytes += await api.sftpUpload(tabId, p, joinPath(cwdRef.current, name));
      }
      setNote(`Uploaded ${paths.length} ${paths.length === 1 ? "file" : "files"} (${fmtSize(bytes)})`);
      await load(cwdRef.current);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (busy) return;
    const picked = await openDialog({ multiple: true, title: "Upload files" });
    if (!picked) return;
    await uploadPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function uploadFolders() {
    if (busy) return;
    const picked = await openDialog({ directory: true, multiple: true, title: "Upload folders" });
    if (!picked) return;
    const dirs = Array.isArray(picked) ? picked : [picked];
    if (dirs.length === 0) return;
    try {
      setBusy(true);
      setError("");
      setNote("");
      let bytes = 0;
      const failed: string[] = [];
      for (const d of dirs) {
        try {
          const name = d.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "folder";
          bytes += await api.sftpUploadDir(tabId, d, joinPath(cwdRef.current, name));
        } catch {
          failed.push(d);
        }
      }
      if (failed.length) setError(`Could not upload: ${failed.join(", ")}`);
      setNote(`Uploaded ${dirs.length - failed.length} of ${dirs.length} ${dirs.length === 1 ? "folder" : "folders"} (${fmtSize(bytes)})`);
      await load(cwdRef.current);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(entry: FileEntry) {
    if (busy) return;
    try {
      if (entry.is_dir) {
        const dir = await openDialog({ directory: true, multiple: false, title: `Download "${entry.name}" into folder` });
        if (typeof dir !== "string" || !dir) return;
        setBusy(true);
        setError("");
        setNote("");
        const dest = await join(dir, entry.name);
        const n = await api.sftpDownloadDir(tabId, entry.path, dest);
        setNote(`Downloaded folder ${entry.name} to ${dest} (${fmtSize(n)})`);
      } else {
        const dest = await saveDialog({ defaultPath: entry.name, title: "Save as" });
        if (!dest) return;
        setBusy(true);
        setError("");
        setNote("");
        const n = await api.sftpDownload(tabId, entry.path, dest);
        setNote(`Downloaded ${entry.name} (${fmtSize(n)})`);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function startFileDrag(entry: FileEntry) {
    try {
      setError("");
      const dest = await join(await tempDir(), `${crypto.randomUUID()}-${entry.name}`);
      await api.sftpDownload(tabId, entry.path, dest);
      const icon = await invoke<string>("drag_icon_path");
      await startDrag({ item: [dest], icon });
    } catch (e) {
      setError(errText(e));
    }
  }

  async function batchDownload() {
    if (busy) return;
    const items = visible.filter((e) => selected.has(e.path));
    if (items.length === 0) return;
    if (items.length === 1) {
      await download(items[0]);
      setSelected(new Set());
      return;
    }
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Download to folder" });
      if (typeof dir !== "string" || !dir) return;
      setBusy(true);
      setError("");
      setNote("");
      let bytes = 0;
      let ok = 0;
      const failed: string[] = [];
      for (const f of items) {
        try {
          const dest = await join(dir, f.name);
          bytes += f.is_dir
            ? await api.sftpDownloadDir(tabId, f.path, dest)
            : await api.sftpDownload(tabId, f.path, dest);
          ok++;
        } catch {
          failed.push(f.name);
        }
      }
      if (failed.length) setError(`Could not download: ${failed.join(", ")}`);
      setNote(`Downloaded ${ok} of ${items.length} to ${dir} (${fmtSize(bytes)})`);
      setSelected(new Set());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function batchDelete() {
    if (busy) return;
    const items = visible.filter((e) => selected.has(e.path));
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const it of items) {
      try {
        if (it.is_dir) await removeRecursive(it.path);
        else await api.sftpRemove(tabId, it.path, false);
      } catch {
        failed.push(it.name);
      }
    }
    setBatchConfirm(false);
    setSelected(new Set());
    if (failed.length) setError(`Could not delete: ${failed.join(", ")}`);
    await load(cwd);
    setBusy(false);
  }

  async function createItem() {
    if (!creating || busy) return;
    const name = creating.name.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    if (entries.some((e) => e.name === name)) {
      setError(`"${name}" already exists here.`);
      return;
    }
    try {
      setBusy(true);
      setNote("");
      setError("");
      const target = joinPath(cwd, name);
      if (creating.kind === "folder") await api.sftpMkdir(tabId, target);
      else await api.sftpWriteText(tabId, target, "");
      setCreating(null);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeRecursive(path: string) {
    const list = await api.sftpList(tabId, path);
    for (const it of list) {
      if (it.is_dir) await removeRecursive(it.path);
      else await api.sftpRemove(tabId, it.path, false);
    }
    await api.sftpRemove(tabId, path, true);
  }

  async function askDelete(entry: FileEntry) {
    setError("");
    if (!entry.is_dir) {
      setConfirmDelete({ entry, recursive: false, count: 0 });
      return;
    }
    try {
      const list = await api.sftpList(tabId, entry.path);
      setConfirmDelete({ entry, recursive: list.length > 0, count: list.length });
    } catch {
      setConfirmDelete({ entry, recursive: false, count: 0 });
    }
  }

  async function confirmDeleteNow() {
    if (!confirmDelete || busy) return;
    const { entry, recursive } = confirmDelete;
    try {
      setBusy(true);
      setError("");
      if (recursive) await removeRecursive(entry.path);
      else await api.sftpRemove(tabId, entry.path, entry.is_dir);
      setConfirmDelete(null);
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
    if (entries.some((e) => e.name === name)) {
      setError(`"${name}" already exists here.`);
      return;
    }
    try {
      setBusy(true);
      setError("");
      await api.sftpRename(tabId, entry.path, joinPath(cwd, name));
      setRenaming(null);
      await load(cwd);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

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
    <div className="relative h-full w-full flex flex-col">
      {dragOver && (
        <div className="absolute inset-0 z-30 m-2 rounded-xl border-2 border-dashed border-ring bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none animate-in fade-in-0 duration-100">
          <div className="flex flex-col items-center gap-2 text-center">
            <Upload className="size-7 text-foreground" />
            <span className="text-sm font-medium">Drop to upload</span>
            <span className="text-xs text-muted-foreground font-mono">{cwd || "/"}</span>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => !busy && setConfirmDelete(null)}
        >
          <div
            className="w-[min(26rem,90%)] rounded-xl border bg-card shadow-xl p-5 flex flex-col gap-4 animate-in zoom-in-95 duration-150"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="size-9 rounded-lg bg-destructive/15 text-destructive grid place-items-center shrink-0">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">
                  Delete {confirmDelete.entry.is_dir ? "folder" : "file"}
                </div>
                <div className="text-sm text-muted-foreground break-all">
                  {confirmDelete.recursive ? (
                    <>
                      <span className="font-mono text-foreground">{confirmDelete.entry.name}</span> contains{" "}
                      {confirmDelete.count} item{confirmDelete.count === 1 ? "" : "s"}. Delete the folder and everything
                      inside? This cannot be undone.
                    </>
                  ) : (
                    <>
                      Delete <span className="font-mono text-foreground">{confirmDelete.entry.name}</span>? This cannot be
                      undone.
                    </>
                  )}
                </div>
              </div>
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs">
                <CircleAlert className="size-3.5 shrink-0 mt-px" />
                <span className="break-all">{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={confirmDeleteNow}
                disabled={busy}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                {busy && <Spinner className="size-4" />}
                {confirmDelete.recursive ? "Delete all" : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmBatch && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => !busy && setConfirmBatch(false)}
        >
          <div
            className="w-[min(26rem,90%)] rounded-xl border bg-card shadow-xl p-5 flex flex-col gap-4 animate-in zoom-in-95 duration-150"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="size-9 rounded-lg bg-destructive/15 text-destructive grid place-items-center shrink-0">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">Delete {selected.size} items</div>
                <div className="text-sm text-muted-foreground">
                  Delete the {selected.size} selected items? Folders are removed with all their contents. This
                  cannot be undone.
                </div>
              </div>
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs">
                <CircleAlert className="size-3.5 shrink-0 mt-px" />
                <span className="break-all">{error}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmBatch(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await batchDelete();
                  setConfirmBatch(false);
                }}
                disabled={busy}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                {busy && <Spinner className="size-4" />}
                Delete all
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-3 h-11 border-b shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(parentPath(cwd))} disabled={busy || cwd === "/"} aria-label="Up">
          <ArrowUp className="size-4" />
        </Button>
        <input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(pathDraft.trim() || "/");
            else if (e.key === "Escape") {
              setPathDraft(cwd);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => setPathDraft(cwd)}
          spellCheck={false}
          data-selectable
          aria-label="Current path"
          title="Type or paste a path, then Enter"
          className="flex-1 min-w-0 px-2 h-8 rounded-md bg-transparent hover:bg-muted/40 focus:bg-muted/60 text-sm font-mono text-foreground/90 outline-none focus:ring-1 focus:ring-ring transition-colors"
        />
        <Button variant="ghost" size="icon-sm" onClick={() => load(cwd)} disabled={busy} aria-label="Refresh">
          <RefreshCw className={"size-4 " + (busy ? "animate-spin" : "")} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setCreating({ kind: "file", name: "" })} disabled={busy} aria-label="New file">
          <FilePlus className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setCreating({ kind: "folder", name: "" })} disabled={busy} aria-label="New folder">
          <FolderPlus className="size-4" />
        </Button>
        <div className="relative">
          <Button variant="secondary" size="sm" onClick={() => setUploadOpen((o) => !o)} disabled={busy}>
            <Upload className="size-4" /> Upload <ChevronDown className="size-3.5 opacity-60" />
          </Button>
          {uploadOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setUploadOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 min-w-40 rounded-md border bg-popover text-popover-foreground shadow-md p-1 text-sm animate-in fade-in-0 zoom-in-95 duration-100">
                <button
                  onClick={() => {
                    setUploadOpen(false);
                    void upload();
                  }}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-left hover:bg-accent"
                >
                  <FileIcon className="size-4 text-muted-foreground" /> Files…
                </button>
                <button
                  onClick={() => {
                    setUploadOpen(false);
                    void uploadFolders();
                  }}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-left hover:bg-accent"
                >
                  <Folder className="size-4 text-muted-foreground" /> Folders…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

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

      {creating !== null && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 shrink-0">
          {creating.kind === "folder" ? (
            <FolderPlus className="size-4 text-muted-foreground shrink-0" />
          ) : (
            <FilePlus className="size-4 text-muted-foreground shrink-0" />
          )}
          <input
            autoFocus
            value={creating.name}
            onChange={(e) => setCreating({ ...creating, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") createItem();
              if (e.key === "Escape") setCreating(null);
            }}
            placeholder={creating.kind === "folder" ? "Folder name" : "File name"}
            className="flex-1 bg-transparent outline-none text-sm"
          />
          <Button size="sm" variant="ghost" onClick={createItem}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(null)}>Cancel</Button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Empty folder</div>
        ) : (
          <div className="flex flex-col">
            {visible.map((e, i) => {
              return (
                <div
                  key={e.path}
                  draggable={!e.is_dir}
                  onDragStart={(ev) => {
                    if (e.is_dir) return;
                    ev.preventDefault();
                    void startFileDrag(e);
                  }}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setCtxMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                  }}
                  className={
                    "group relative flex items-center gap-3 px-3 h-9 border-b border-border/50 hover:bg-muted text-sm " +
                    (e.is_dir ? "" : "cursor-grab active:cursor-grabbing")
                  }
                >
                  <Checkbox
                    checked={selected.has(e.path)}
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      selectAt(i, ev.shiftKey);
                    }}
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
                      <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={() => doRename(e)} aria-label="Confirm rename">
                        <Check className="size-4 text-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={() => setRenaming(null)} aria-label="Cancel">
                        <X className="size-4" />
                      </Button>
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
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(error || note) && (
        <div
          className={
            "flex items-start gap-2 px-3 py-1.5 text-xs border-t shrink-0 " +
            (error ? "bg-destructive/10 text-destructive" : "text-muted-foreground")
          }
        >
          {error && <CircleAlert className="size-3.5 shrink-0 mt-px" />}
          <span className="flex-1 break-all">{error || note}</span>
          {error && (
            <button
              onClick={() => {
                setError("");
                setNote("");
              }}
              aria-label="Dismiss"
              className="shrink-0 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-44 rounded-md border bg-popover text-popover-foreground shadow-md p-1 text-sm animate-in fade-in-0 zoom-in-95 duration-100"
            style={{
              left: Math.max(0, Math.min(ctxMenu.x, window.innerWidth - 200)),
              top: Math.max(0, Math.min(ctxMenu.y, window.innerHeight - 230)),
            }}
          >
            {(() => {
              const e = ctxMenu.entry;
              const close = () => setCtxMenu(null);
              const item = (icon: ReactNode, label: string, onClick: () => void, danger = false) => (
                <button
                  onClick={() => {
                    close();
                    onClick();
                  }}
                  className={
                    "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-left hover:bg-accent " +
                    (danger ? "text-destructive hover:bg-destructive/10" : "")
                  }
                >
                  <span className={danger ? "text-destructive" : "text-muted-foreground"}>{icon}</span>
                  {label}
                </button>
              );
              const multi = selected.has(e.path) && selected.size > 1;
              if (multi) {
                return (
                  <>
                    {item(<Download className="size-4" />, `Download ${selected.size} items`, () => batchDownload())}
                    <div className="my-1 h-px bg-border" />
                    {item(<Trash2 className="size-4" />, `Delete ${selected.size} items`, () => {
                      setError("");
                      setConfirmBatch(true);
                    }, true)}
                  </>
                );
              }
              return (
                <>
                  {e.is_dir
                    ? item(<Folder className="size-4" />, "Open", () => navigate(e.path))
                    : item(<SquarePen className="size-4" />, "Edit", () => openEditor(e))}
                  {item(<Download className="size-4" />, "Download", () => download(e))}
                  {item(<Pencil className="size-4" />, "Rename", () => setRenaming({ path: e.path, value: e.name }))}
                  <div className="my-1 h-px bg-border" />
                  {item(<Trash2 className="size-4" />, "Delete", () => askDelete(e), true)}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
