import { useCallback, useEffect, useRef, useState } from "react";
import { remoteBrowserStartAt, useStore } from "../store";
import { useSettings } from "../settings";
import {
  confirmOverwrite,
  confirmReplaceRemote,
  copyToClipboard,
  downloadRemote,
  githubResolveUrl,
  listRemoteDir,
  makeRemoteDir,
  pickDownloadPath,
  remoteStat,
  uploadRemote,
  writeRemoteFile,
} from "../ipc";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CopyButton } from "./CopyButton";
import type { RemoteListing } from "../ipc";
import { isGithubHost, isGithubUrl, isValidHost, splitGithubSpec, splitLineSuffix } from "../remote";
import { basename, displayTitle, isCodePath } from "../types";

const HOST_KEY = "remoteBrowserHost";
const VIEW_KEY = "remoteBrowserView";
const SORT_KEY = "remoteBrowserSort";
const WIDTHS_KEY = "remoteBrowserColumns";

/** Date Modified and Size column widths (px); Name takes the rest. */
interface Widths {
  modified: number;
  size: number;
}
const DEFAULT_WIDTHS: Widths = { modified: 150, size: 64 };

function loadWidths(): Widths {
  try {
    const w = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "");
    if (typeof w?.modified === "number" && typeof w?.size === "number") return w;
  } catch {
    /* default below */
  }
  return DEFAULT_WIDTHS;
}

type SortKey = "name" | "modified" | "size";
interface Sort {
  key: SortKey;
  desc: boolean;
}

function loadSort(): Sort {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "");
    if (["name", "modified", "size"].includes(s?.key)) return { key: s.key, desc: !!s.desc };
  } catch {
    /* default below */
  }
  return { key: "modified", desc: true };
}

/** Like Finder: "Today at 2:41 PM", "Yesterday at …", else "Nov 2, 2026 at 1:34 PM". */
function formatModified(seconds?: number): string {
  if (seconds == null) return "--";
  const d = new Date(seconds * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  if (day === today) return `Today at ${time}`;
  if (day === today - 86_400_000) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "--";
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
const dirKey = (host: string) => `remoteBrowserDir:${host}`;
const DOC_RE = /\.(md|markdown|mdown|mkdn|mkd|txt|csv|tsv|json|jsonl|ndjson|svg|png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const MARKDOWN_RE = /\.(md|markdown|mdown|mkdn|mkd)$/i;
/** Files that can't be opened as text: clicking one downloads it instead. */
const BINARY_RE =
  /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|whl|dmg|pkg|iso|bin|exe|so|dylib|o|a|class|pyc|heic|tiff?|pdf|docx?|xlsx?|pptx?|mp3|mp4|mov|wav|avi|mkv|parquet|db|sqlite)$/i;
/** `host:/path` or `host:~/path` pasted into the path bar switches host too. */
const SPEC_RE = /^([A-Za-z0-9._@[\]-]+):((?:~|\/).*)$/;

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function FolderIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 16 13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.5 1h4.3l1.5 1.6h7.2c.6 0 1 .4 1 1V11c0 .6-.4 1-1 1H1.5c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 15" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        d="M1.5.8h6l3.7 3.7v9c0 .4-.3.7-.7.7h-9a.7.7 0 0 1-.7-.7V1.5c0-.4.3-.7.7-.7Z"
      />
    </svg>
  );
}

/**
 * Remote file browser, shared by "Open Remote…" and "Save to Remote…". Lists
 * directories over the system `ssh` (so ~/.ssh/config aliases and proxies
 * apply). Remembers the last host and, per host, the last folder.
 */
export function RemoteBrowser() {
  const mode = useStore((s) => s.remoteBrowser);
  // Mount fresh per open so state (listing, drafts) always starts clean.
  return mode ? <Browser mode={mode} /> : null;
}

function Browser({ mode }: { mode: "open" | "save" }) {
  const close = () => useStore.getState().setRemoteBrowser(null);

  // Starting point: saving a doc that already lives remotely starts next to it;
  // otherwise the last host/folder used, then the configured default host.
  const [initial] = useState(() => {
    const s = useStore.getState();
    const doc = s.docs[s.activeId];
    const defaultHost = useSettings.getState().settings.defaultRemoteHost;
    // Opened for a GitHub folder link.
    const start = remoteBrowserStartAt();
    if (start) return { host: start.host, dir: start.path, name: "" };
    // Start next to the active remote document (open or save), like most
    // apps' Open dialogs; otherwise the last host/folder used.
    if (doc?.remote) {
      return { host: doc.remote.host, dir: parentOf(doc.remote.path), name: basename(doc.remote.path) };
    }
    const host = localStorage.getItem(HOST_KEY) || defaultHost || "";
    const title = doc ? displayTitle(doc).replace(/[/\\:]/g, "-") : "Untitled";
    const name = doc?.path ? basename(doc.path) : /\.\w+$/.test(title) ? title : `${title}.md`;
    return { host, dir: (host && localStorage.getItem(dirKey(host))) || "~", name };
  });

  const [host, setHost] = useState(initial.host);
  const [hostDraft, setHostDraft] = useState(initial.host);
  const [pathDraft, setPathDraft] = useState(initial.dir);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A folder that doesn't exist (yet): offered to create, and Save creates it.
  const [missing, setMissing] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [fileName, setFileName] = useState(initial.name);
  // List view (columns: date modified, size), the default, or names only.
  const [listView, setListView] = useState(() => localStorage.getItem(VIEW_KEY) !== "names");
  const [sort, setSort] = useState<Sort>(loadSort);
  const [widths, setWidths] = useState<Widths>(loadWidths);
  // Drag a column divider, like Finder: left of Date Modified trades width
  // between Name and Date Modified, left of Size between Date Modified and Size.
  const startResize = (edge: "modified" | "size") => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const x0 = event.clientX;
    const w0 = widths;
    document.body.classList.add("resizing-x");
    let latest = w0;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      latest =
        edge === "modified"
          ? { ...w0, modified: Math.min(320, Math.max(48, w0.modified - dx)) }
          : (() => {
              const modified = Math.min(320, Math.max(48, w0.modified + dx));
              return { modified, size: Math.max(40, w0.size - (modified - w0.modified)) };
            })();
      setWidths(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x");
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(latest));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const sortBy = (key: SortKey) => {
    // A new column starts newest/biggest first (like Finder), name A-Z.
    const next = sort.key === key ? { key, desc: !sort.desc } : { key, desc: key !== "name" };
    setSort(next);
    localStorage.setItem(SORT_KEY, JSON.stringify(next));
  };
  const toggleView = (on: boolean) => {
    setListView(on);
    localStorage.setItem(VIEW_KEY, on ? "list" : "names");
  };
  const request = useRef(0);
  // True once the user types/pastes in the path bar; a listing that finishes
  // afterwards must not overwrite what they entered.
  const pathEdited = useRef(false);
  // Opened from a remote document: its file is highlighted (and scrolled to,
  // once) in the folder the browser starts in. That folder as the remote shell
  // resolved it, so a symlinked path still matches.
  const startDir = useRef<string | null>(null);
  const revealed = useRef(false);

  const load = useCallback(async (h: string, dir: string, fromTyping = false) => {
    if (!fromTyping) pathEdited.current = false;
    if (!isValidHost(h)) {
      setListing(null);
      setError(
        h
          ? `Invalid host: ${h}`
          : "Enter an SSH host (an alias from ~/.ssh/config works), github:owner/repo@branch, or paste a GitHub link.",
      );
      return;
    }
    // Ignore responses from superseded requests (fast clicking through folders).
    const id = ++request.current;
    setLoading(true);
    setError(null);
    setMissing(null);
    try {
      const result = await listRemoteDir(h, dir);
      if (id !== request.current) return;
      result.entries.sort((a, b) =>
        a.isDir !== b.isDir
          ? a.isDir
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      );
      startDir.current ??= result.dir;
      setListing(result);
      if (!pathEdited.current) setPathDraft(result.dir);
      localStorage.setItem(HOST_KEY, h);
      localStorage.setItem(dirKey(h), result.dir);
    } catch (err) {
      if (id !== request.current) return false;
      // `cd` into a file: the caller decides what to do with it (download).
      if (/not a directory/i.test(String(err))) return true;
      if (/no such file or directory/i.test(String(err))) {
        setListing(null);
        setMissing(dir);
        if (!pathEdited.current) setPathDraft(dir);
        return false;
      }
      setError(String(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
    return false;
  }, []);

  useEffect(() => {
    void load(initial.host, initial.dir);
  }, [load, initial]);

  // "New File…" / "New Folder…": the name being typed for it.
  const [naming, setNaming] = useState<{ kind: "file" | "folder"; draft: string } | null>(null);
  const namingRef = useRef(naming);
  namingRef.current = naming;

  // Escape closes (capture phase, so it beats other window-level handlers);
  // while a new file or folder is being named, it only cancels that.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (namingRef.current) setNaming(null);
      else useStore.getState().setRemoteBrowser(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // A pasted github.com link: browse its folder, or open the file it points at.
  const goToGithubUrl = async (url: string): Promise<boolean> => {
    try {
      const { host: h, path, isDir } = await githubResolveUrl(url);
      setHost(h);
      setHostDraft(h);
      if (isDir) void load(h, path);
      else if (mode === "open") openFile(h, path);
      else {
        setFileName(basename(path));
        void load(h, parentOf(path));
      }
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  };

  // "Open from GitHub…": a link, or owner/repo with an optional @branch.
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubDraft, setGithubDraft] = useState("");
  const submitGithub = async () => {
    const text = githubDraft.trim();
    const short = /^([\w.-]+\/[\w.-]+)(?:@(.+))?$/.exec(text);
    let ok: boolean;
    if (short?.[2]) {
      const h = `github:${short[1]}@${short[2]}`;
      ok = isGithubHost(h);
      if (ok) switchHost(h);
      else setError(`Not a valid GitHub repo and branch: ${text}`);
    } else if (short || isGithubUrl(text)) {
      ok = await goToGithubUrl(short ? `https://github.com/${short[1]}` : text);
    } else {
      setError("Paste a github.com link, or type owner/repo (add @branch for another branch).");
      ok = false;
    }
    if (ok) setGithubOpen(false);
  };

  const switchHost = (next: string) => {
    if (isGithubUrl(next)) return void goToGithubUrl(next.trim());
    const h = next.trim();
    setHost(h);
    setHostDraft(h);
    void load(h, localStorage.getItem(dirKey(h)) || "~");
  };

  // Download a remote file/folder to a place picked in a save dialog.
  const download = async (path: string, fromHost = host) => {
    const local = await pickDownloadPath(basename(path));
    if (!local) return;
    setUpload(`Downloading ${basename(path)} from ${fromHost}…`);
    try {
      await downloadRemote(fromHost, path, local);
      setUpload(`Downloaded to ${local}`);
      void revealItemInDir(local);
    } catch (err) {
      setUpload(null);
      setError(String(err));
    }
  };

  // New File… / New Folder… in the folder shown (not on GitHub: read-only).
  const createItems = () =>
    listing && !isGithubHost(host)
      ? [
          ...(mode === "open"
            ? [MenuItem.new({ text: "New File…", action: () => setNaming({ kind: "file", draft: "untitled.md" }) })]
            : []),
          MenuItem.new({ text: "New Folder…", action: () => setNaming({ kind: "folder", draft: "untitled folder" }) }),
        ]
      : [];

  const showEntryMenu = async (path: string, isDir: boolean) => {
    const create = createItems();
    const items = await Promise.all([
      ...(isDir
        ? [MenuItem.new({ text: "Open Folder", action: () => void load(host, path) })]
        : [MenuItem.new({ text: "Open", action: () => openFile(host, path) })]),
      MenuItem.new({ text: "Download…", action: () => void download(path) }),
      MenuItem.new({ text: "Copy Path", action: () => void copyToClipboard(copyWithHost ? `${host}:${path}` : path) }),
      ...(create.length ? [PredefinedMenuItem.new({ item: "Separator" }), ...create] : []),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // Right-click on the list's empty space: the folder's own menu.
  const showFolderMenu = async () => {
    const create = createItems();
    if (!create.length) return;
    await (await Menu.new({ items: await Promise.all(create) })).popup();
  };

  // Create the named file (empty, then open it to edit) or folder (then show it).
  const createNamed = async () => {
    const dir = listing?.dir;
    const name = naming?.draft.trim().replace(/\/+$/, "");
    if (!naming || !dir || !name) return;
    if (name.startsWith("/") || name.startsWith("~") || name.split("/").includes("..")) {
      setError("Type a name inside this folder (subfolders like notes/today.md are fine).");
      return;
    }
    const target = joinPath(dir, name);
    setError(null);
    try {
      await remoteStat(host, target);
      setError(`${name} already exists here.`);
      return;
    } catch (err) {
      if (!/no such file/i.test(String(err))) {
        setError(String(err));
        return;
      }
    }
    try {
      if (naming.kind === "folder") {
        await makeRemoteDir(host, target);
        setNaming(null);
        void load(host, target);
        return;
      }
      if (name.includes("/")) await makeRemoteDir(host, parentOf(target));
      await writeRemoteFile(host, target, "");
    } catch (err) {
      setError(String(err));
      return;
    }
    const h = host;
    close();
    const s = useStore.getState();
    await s.openRemote(h, target);
    // A new file is for writing: show the editor, not just an empty preview.
    const doc = Object.values(useStore.getState().docs).find((d) => d.remote?.host === h && d.remote.path === target);
    if (doc && useStore.getState().views[doc.id]?.mode === "preview") s.setMode(doc.id, "editor");
  };

  const openFile = (h: string, path: string) => {
    close();
    void useStore.getState().openRemote(h, path);
  };

  // `mkdir -p` the missing folder, then show it.
  const createFolder = async () => {
    if (!missing) return false;
    setUpload(`Creating ${host}:${missing}…`);
    try {
      await makeRemoteDir(host, missing);
    } catch (err) {
      setUpload(null);
      setError(String(err));
      return false;
    }
    setUpload(null);
    await load(host, missing);
    return true;
  };

  const save = async (name = fileName.trim()) => {
    const dir = listing?.dir ?? missing;
    if (!dir || !name) return;
    const target = name.startsWith("/") || name.startsWith("~") ? name : joinPath(dir, name);
    // A folder typed as the name: go there rather than save over it.
    if (name.endsWith("/")) {
      setFileName(initial.name);
      void load(host, target);
      return;
    }
    if (!listing && !(await createFolder())) return;
    // A name with folders in it ("notes/today.md"): create any that are missing.
    if (name.includes("/")) {
      try {
        await makeRemoteDir(host, parentOf(target));
      } catch (err) {
        setError(String(err));
        return;
      }
    }
    const exists = listing?.entries.some((e) => !e.isDir && e.name === name);
    if (exists && !(await confirmOverwrite(name))) return;
    const s = useStore.getState();
    if (await s.saveToRemote(s.activeId, host, target)) close();
  };

  // Path bar: a folder navigates; a file path opens it (or, when saving,
  // selects its folder + name); a pasted `host:/path` switches host too.
  const submitPath = () => {
    let h = host;
    let p = pathDraft.trim() || "~";
    if (isGithubUrl(p)) return void goToGithubUrl(p);
    const github = splitGithubSpec(p);
    const spec = github ? [p, github.host, github.path] : SPEC_RE.exec(p);
    if (spec && isValidHost(spec[1])) {
      h = spec[1];
      p = spec[2];
      setHost(h);
      setHostDraft(h);
    }
    // "file.md:33" (line suffix) opens the file at that line.
    const { path: bare, line } = splitLineSuffix(p);
    if (DOC_RE.test(bare) || isCodePath(bare)) {
      if (mode === "open") {
        close();
        void useStore.getState().openRemote(h, bare, line);
        return;
      }
      p = bare;
      setFileName(basename(p));
      p = parentOf(p);
    }
    // A non-text file (image, archive, PDF, …): download it, like clicking it.
    if (mode === "open" && BINARY_RE.test(bare)) {
      void load(h, parentOf(bare));
      void download(bare, h);
      return;
    }
    void load(h, p).then((notDir) => {
      // Any other file typed in (no known extension): download it too.
      if (notDir && mode === "open") {
        void load(h, parentOf(bare));
        void download(bare, h);
      }
    });
  };

  // Files dropped onto the browser: copy them into the folder it's showing.
  const remoteDrop = useStore((st) => st.remoteDrop);
  const [upload, setUpload] = useState<string | null>(null);
  useEffect(() => {
    if (!remoteDrop) return;
    useStore.getState().setRemoteDrop(null);
    const dir = listing?.dir;
    if (!dir || !isValidHost(host)) {
      setError("Open a folder first, then drop files onto it.");
      return;
    }
    const paths = remoteDrop;
    const names = paths.map((p) => basename(p)).join(", ");
    const existing = new Set((listing?.entries ?? []).map((e) => e.name));
    const clashes = paths.map((p) => basename(p)).filter((n) => existing.has(n));
    void (async () => {
      // Confirm before replacing anything already in the folder.
      if (clashes.length && !(await confirmReplaceRemote(clashes, `${host}:${dir}`))) return;
      setUpload(`Copying ${names} to ${host}:${dir}…`);
      try {
        await uploadRemote(host, paths, dir);
        setUpload(`Copied ${names} to ${host}:${dir}`);
        void load(host, dir);
      } catch (err) {
        setUpload(null);
        setError(String(err));
      }
    })();
  }, [remoteDrop, listing, host, load]);
  const copyWithHost = useSettings((st) => st.settings.copyPathWithHost);

  const visible = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
  // The host reported times and sizes (not GitHub, not hosts without GNU find).
  const hasMeta = visible.some((e) => e.modified != null);
  const columns = listView && hasMeta;
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const entries =
    columns && sort.key !== "name"
      ? [...visible].sort((a, b) => {
          const va = sort.key === "modified" ? (a.modified ?? 0) : a.isDir ? -1 : (a.size ?? 0);
          const vb = sort.key === "modified" ? (b.modified ?? 0) : b.isDir ? -1 : (b.size ?? 0);
          return (sort.desc ? vb - va : va - vb) || byName(a, b);
        })
      : columns && sort.desc
        ? [...visible].reverse()
        : visible;
  const dir = listing?.dir ?? null;
  // Markdown files in this folder (not subfolders), for "Open all".
  const markdownHere = dir ? entries.filter((e) => !e.isDir && MARKDOWN_RE.test(e.name)) : [];
  const openAllMarkdown = () => {
    if (!dir) return;
    const h = host;
    const paths = markdownHere.map((e) => joinPath(dir, e.name));
    close();
    void (async () => {
      for (const path of paths) await useStore.getState().openRemote(h, path);
    })();
  };

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="remote-prompt remote-browser" onClick={(event) => event.stopPropagation()}>
        <div className="rb-header">
          <span className="remote-prompt-label">
            {mode === "open" ? "Open remote file" : "Save to remote"}
          </span>
          <span className="rb-header-tools">
            <span className="rb-view" role="radiogroup" aria-label="View">
              <button className={listView ? "on" : ""} data-tip="List: date modified and size" onClick={() => toggleView(true)}>
                List
              </button>
              <button className={listView ? "" : "on"} data-tip="Names only" onClick={() => toggleView(false)}>
                Names
              </button>
            </span>
            <label className="rb-hidden-toggle">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              Hidden files
            </label>
          </span>
        </div>

        {mode === "open" && !githubOpen && (
          <button className="rb-github-btn" onClick={() => setGithubOpen(true)}>
            Open from GitHub…
          </button>
        )}
        {githubOpen && (
          <div className="rb-location">
            <input
              className="remote-prompt-input rb-path"
              placeholder="Paste a GitHub link, or owner/repo (owner/repo@branch for another branch)"
              value={githubDraft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              onChange={(event) => setGithubDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitGithub();
                }
              }}
            />
            <button className="rb-github-btn" onClick={() => void submitGithub()}>
              Open
            </button>
            <button className="rb-github-btn" onClick={() => setGithubOpen(false)}>
              Cancel
            </button>
          </div>
        )}

        <div className="rb-location">
          <input
            className={`remote-prompt-input rb-host${isGithubHost(hostDraft.trim()) ? " rb-host-github" : ""}`}
            placeholder="host or github:owner/repo@branch"
            value={hostDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setHostDraft(event.target.value)}
            onBlur={() => hostDraft.trim() !== host && switchHost(hostDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                switchHost(hostDraft);
              }
            }}
          />
          <span className="rb-colon">:</span>
          <input
            className="remote-prompt-input rb-path"
            placeholder="~ for home, /abs/path, or paste host:/path or a GitHub link"
            title={pathDraft}
            value={pathDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            // Opening: focus and select the path so ⌘V replaces it and Enter opens.
            autoFocus={mode === "open"}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              pathEdited.current = true;
              setPathDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                pathEdited.current = false;
                submitPath();
              }
            }}
          />
          <CopyButton
            text={dir ? (copyWithHost ? `${host}:${dir}` : dir) : ""}
            tip="Copy this folder's path"
          />
        </div>

        {dir && (
          <nav className="rb-crumbs" aria-label="Current folder">
            <span className="rb-crumb-host">{host}</span>
            <span className="rb-crumb-sep">:</span>
            <button className="rb-crumb" onClick={() => void load(host, "/")}>
              /
            </button>
            {dir
              .split("/")
              .filter(Boolean)
              .map((part, i, parts) => (
                <span key={i} style={{ display: "contents" }}>
                  {i > 0 && <span className="rb-crumb-sep">/</span>}
                  <button
                    className={`rb-crumb${i === parts.length - 1 ? " current" : ""}`}
                    onClick={() => void load(host, "/" + parts.slice(0, i + 1).join("/"))}
                  >
                    {part}
                  </button>
                </span>
              ))}
          </nav>
        )}

        {naming && (
          <div className="rb-location">
            <span className="rb-save-label">{naming.kind === "file" ? "New file" : "New folder"}</span>
            <input
              className="remote-prompt-input rb-path"
              value={naming.draft}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              // Select the name without its extension, like Finder.
              onFocus={(event) => {
                const dot = naming.kind === "file" ? event.currentTarget.value.lastIndexOf(".") : -1;
                event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
              }}
              onChange={(event) => setNaming({ ...naming, draft: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createNamed();
                }
              }}
            />
            <button className="rb-github-btn" onClick={() => void createNamed()} disabled={!naming.draft.trim()}>
              Create
            </button>
            <button className="rb-github-btn" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </div>
        )}

        <div
          className="rb-list"
          aria-busy={loading}
          style={{ "--rb-mod-w": `${widths.modified}px`, "--rb-size-w": `${widths.size}px` } as React.CSSProperties}
          onContextMenu={(e) => {
            e.preventDefault();
            void showFolderMenu();
          }}
        >
          {error ? (
            <div className="rb-status rb-error">{error}</div>
          ) : missing ? (
            <div className="rb-status">
              <p className="rb-missing">
                {host}:{missing} doesn't exist yet.
                {mode === "save" ? " Save will create it." : ""}
              </p>
              <button className="rb-create" onClick={() => void createFolder()}>
                Create Folder
              </button>
            </div>
          ) : !listing ? (
            <div className="rb-status">Connecting…</div>
          ) : (
            <>
              {columns && (
                <div className="rb-row rb-columns">
                  {(["name", "modified", "size"] as const).map((key) => (
                    <button
                      key={key}
                      className={`rb-col-${key}${sort.key === key ? " on" : ""}`}
                      title={key === "name" ? undefined : "Drag the left edge to resize"}
                      onClick={() => sortBy(key)}
                    >
                      {key !== "name" && (
                        <span
                          className="rb-col-resize"
                          onPointerDown={startResize(key)}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setWidths(DEFAULT_WIDTHS);
                            localStorage.removeItem(WIDTHS_KEY);
                          }}
                        />
                      )}
                      {key === "name" ? "Name" : key === "modified" ? "Date Modified" : "Size"}
                      {sort.key === key && <span className="rb-sort">{sort.desc ? "▼" : "▲"}</span>}
                    </button>
                  ))}
                </div>
              )}
              {dir !== "/" && (
                <div className="rb-row rb-dir" onClick={() => void load(host, parentOf(dir!))}>
                  <FolderIcon />
                  <span className="rb-name">..</span>
                </div>
              )}
              {entries.map((entry) => {
                const doc = DOC_RE.test(entry.name);
                const selected =
                  !entry.isDir &&
                  (mode === "save"
                    ? entry.name === fileName
                    : !!initial.name && listing.dir === startDir.current && entry.name === initial.name);
                return (
                  <div
                    key={entry.name}
                    className={`rb-row${entry.isDir ? " rb-dir" : doc ? " rb-doc" : " rb-other"}${
                      selected ? " selected" : ""
                    }`}
                    title={entry.name}
                    ref={(el) => {
                      if (el && selected && mode === "open" && !revealed.current) {
                        revealed.current = true;
                        el.scrollIntoView({ block: "center" });
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void showEntryMenu(joinPath(listing.dir, entry.name), entry.isDir);
                    }}
                    onClick={() => {
                      if (entry.isDir) void load(host, joinPath(listing.dir, entry.name));
                      else if (BINARY_RE.test(entry.name)) void download(joinPath(listing.dir, entry.name));
                      else if (mode === "open") openFile(host, joinPath(listing.dir, entry.name));
                      else setFileName(entry.name);
                    }}
                    onDoubleClick={() => {
                      if (!entry.isDir && mode === "save") void save(entry.name);
                    }}
                  >
                    {entry.isDir ? <FolderIcon /> : <FileIcon />}
                    <span className="rb-name">{entry.name}</span>
                    {columns && (
                      <>
                        <span className="rb-col-modified">{formatModified(entry.modified)}</span>
                        <span className="rb-col-size">{entry.isDir ? "--" : formatSize(entry.size)}</span>
                      </>
                    )}
                  </div>
                );
              })}
              {entries.length === 0 && <div className="rb-status">Empty folder</div>}
            </>
          )}
          {loading && listing && <div className="rb-loading" />}
        </div>

        {mode === "save" && (
          <div className="rb-save">
            <span className="rb-save-label">Name</span>
            <input
              className="remote-prompt-input"
              value={fileName}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              onChange={(event) => setFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        )}

        <div className="remote-prompt-actions">
          <span className="rb-where" title={dir ? `${host}:${dir}` : ""}>
            {upload ??
              (dir
                ? isGithubHost(host)
                  ? `${host}:${dir}`
                  : `${host}:${dir} · drop files here to copy them in`
                : "")}
          </span>
          <button className="remote-prompt-cancel" onClick={close}>
            Cancel
          </button>
          {mode === "open" && markdownHere.length > 0 && (
            <button className="remote-prompt-open" onClick={openAllMarkdown}>
              Open all {markdownHere.length} .md file{markdownHere.length === 1 ? "" : "s"}
            </button>
          )}
          {mode === "save" && (
            <button
              className="remote-prompt-open"
              onClick={() => void save()}
              disabled={!(listing || missing) || !fileName.trim()}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
