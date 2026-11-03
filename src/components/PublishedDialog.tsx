import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { forgetPages, publishedPages, refreshPublished } from "../publish";
import { pageMatches, protectedPageId } from "../publishSearch";
import { copyToClipboard, linkStatus, pagesPasswordGet, pathExists } from "../ipc";
import { basename } from "../types";
import { CopyButton } from "./CopyButton";

/** Copies a protected page's password from this Mac's Keychain. */
function CopyPassword({ id }: { id: string }) {
  const [note, setNote] = useState<string | null>(null);
  const copy = async () => {
    try {
      const saved = await pagesPasswordGet(id);
      if (saved) {
        await copyToClipboard(saved);
        setNote("Password copied");
      } else {
        setNote("Its password isn't saved on this Mac");
      }
    } catch (err) {
      setNote(String(err));
    }
    setTimeout(() => setNote(null), 2500);
  };
  return (
    <span className="pub-password">
      <button className="publish-edit" onClick={() => void copy()}>
        Copy password
      </button>
      {note && <span className="pub-note">{note}</span>}
    </span>
  );
}

/**
 * Links not to check by fetching: pages and gists are checked through the
 * GitHub API by `refreshPublished` (a fresh page can 404 until Pages builds
 * it), and github.com answers 404 for private files to a request without login.
 */
function skipLinkCheck(url: string): boolean {
  return !!protectedPageId(url) || /^https:\/\/(gist\.)?github\.com\//.test(url);
}

/** Statuses that mean the page is gone, not just behind a login. */
const GONE = new Set([404, 410]);

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * File → Published Documents… (⌘P): everything published from this Mac,
 * newest first, searchable by title, file or link. Pasting a page's link
 * finds the file it was published from.
 */
export function PublishedDialog() {
  const open = useStore((s) => s.publishedOpen);
  return open ? <Published /> : null;
}

function Published() {
  const close = () => useStore.getState().setPublishedOpen(false);
  const tick = useStore((s) => s.publishTick);
  const [query, setQuery] = useState("");
  // Pages on GitHub Pages that this Mac's history doesn't know about (public
  // or protected: Copy password says when there's no password saved).
  const [repoPages, setRepoPages] = useState<{ id: string; url: string }[]>([]);
  // Local files pages were published from that are gone (moved or deleted).
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Published links that answer 404/410, with the status.
  const [unavailable, setUnavailable] = useState<Map<string, number>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const live = useRef(true);
  const refresh = async (quiet: boolean) => {
    setRefreshing(true);
    setRefreshNote(null);
    const listed = publishedPages();
    const local = [...new Set(listed.filter((p) => !p.host).map((p) => p.path))];
    const links = listed.map((p) => p.url).filter((url) => !skipLinkCheck(url));
    // Unreachable (offline, VPN down) proves nothing: those stay available.
    const checks = Promise.allSettled(links.map(async (url) => [url, await linkStatus(url)] as const));
    const [pagesResult, existsResult] = await Promise.allSettled([
      refreshPublished(),
      Promise.all(local.map(async (path) => [path, await pathExists(path)] as const)),
    ]);
    const statuses = await checks;
    if (!live.current) return;
    setRefreshing(false);
    setUnavailable(
      new Map(
        statuses.flatMap((r) => (r.status === "fulfilled" && GONE.has(r.value[1]) ? [r.value] : [])),
      ),
    );
    if (pagesResult.status === "fulfilled") setRepoPages(pagesResult.value);
    else if (!quiet) setRefreshNote(`Couldn't check GitHub: ${String(pagesResult.reason)}`);
    // On open, no gh login or offline: just the history.
    if (existsResult.status === "fulfilled") {
      setMissing(new Set(existsResult.value.filter(([, exists]) => !exists).map(([path]) => path)));
    } else if (!quiet) setRefreshNote(`Couldn't check files: ${String(existsResult.reason)}`);
  };
  useEffect(() => {
    live.current = true;
    void refresh(true);
    return () => {
      live.current = false;
    };
  }, []);
  const pages = publishedPages(tick);
  const shown = pages.filter((p) => pageMatches({ ...p, title: p.title || basename(p.path) }, query));
  const known = new Set(pages.map((p) => protectedPageId(p.url)).filter(Boolean));
  const extra = repoPages
    .filter((r) => !known.has(r.id))
    .filter((r) =>
      pageMatches({ title: "GitHub Pages page", key: r.url, url: r.url, id: r.id, targetLabel: "" }, query),
    );
  // A pasted protected-page link that isn't listed (an unsaved doc, or
  // published from another Mac): still offer its password if it's saved here.
  const pastedPage = protectedPageId(query);
  const unlisted =
    pastedPage &&
    !shown.some((p) => protectedPageId(p.url) === pastedPage) &&
    !extra.some((r) => r.id === pastedPage)
      ? pastedPage
      : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      useStore.getState().setPublishedOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const openSource = (host: string | undefined, path: string) => {
    close();
    const s = useStore.getState();
    void (host ? s.openRemote(host, path) : s.openPaths([path]));
  };

  const link = (href: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    void openUrl(href);
  };

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="remote-prompt published-dialog" onClick={(event) => event.stopPropagation()}>
        <span className="remote-prompt-label">Published documents</span>
        <input
          className="remote-prompt-input"
          placeholder="Search by title, file or link (paste a link to find its file)"
          value={query}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="pub-list">
          {unlisted && (
            <div className="pub-row">
              <div className="pub-title">GitHub Pages page</div>
              <div className="pub-meta">Not in this Mac's publish history.</div>
              <div className="pub-link">
                <a href={query.trim()} onClick={link(query.trim())} title={query.trim()}>
                  {query.trim().replace(/^https?:\/\//, "")}
                </a>
                <CopyPassword id={unlisted} />
              </div>
            </div>
          )}
          {extra.map((r) => (
            <div key={r.id} className="pub-row">
              <div className="pub-title">GitHub Pages page</div>
              <div className="pub-meta">On your GitHub Pages; not in this Mac's publish history.</div>
              <div className="pub-link">
                <a href={r.url} onClick={link(r.url)} title={r.url}>
                  {r.url.replace(/^https?:\/\//, "")}
                </a>
                <CopyButton text={r.url} tip="Copy link" />
                <CopyPassword id={r.id} />
              </div>
            </div>
          ))}
          {unlisted || extra.length > 0 || shown.length > 0 ? null : pages.length === 0 ? (
            <p className="rb-status">Nothing published yet. Publish a document with ⇧⌘P.</p>
          ) : (
            <p className="rb-status">No published document matches “{query.trim()}”.</p>
          )}
          {(
            shown.map((p) => (
              <div key={p.url} className="pub-row">
                <div className="pub-title">{p.title || basename(p.path).replace(/\.\w+$/, "")}</div>
                {!p.host && missing.has(p.path) ? (
                  <span className="pub-source pub-missing" title="This file was moved or deleted">
                    {p.path} (not found)
                  </span>
                ) : (
                  <button
                    className="pub-source"
                    title="Open this file"
                    onClick={() => openSource(p.host, p.path)}
                  >
                    {p.host ? `${p.host}:${p.path}` : p.path}
                  </button>
                )}
                <div className="pub-meta">
                  <span>{p.targetLabel}</span>
                  <span aria-hidden="true"> · </span>
                  <span>
                    {p.updates > 0
                      ? `published ${when(p.first)}, updated ${p.updates}× (last ${when(p.at)})`
                      : `published ${when(p.first)}`}
                  </span>
                </div>
                <div className="pub-link">
                  <a
                    href={p.url}
                    className={unavailable.has(p.url) ? "pub-gone" : undefined}
                    onClick={link(p.url)}
                    title={p.url}
                  >
                    {p.url.replace(/^https?:\/\//, "")}
                  </a>
                  {unavailable.has(p.url) && (
                    <span className="pub-note">Unavailable ({unavailable.get(p.url)})</span>
                  )}
                  <CopyButton text={p.url} tip="Copy link" />
                  {protectedPageId(p.url) && !p.open && <CopyPassword id={protectedPageId(p.url)!} />}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="remote-prompt-actions">
          <span className="rb-where" title={refreshNote ?? undefined}>
            {refreshNote ??
              (pages.length + repoPages.length > 0 &&
                `${shown.length + extra.length} of ${pages.length + repoPages.filter((r) => !known.has(r.id)).length}`)}
          </span>
          {unavailable.size > 0 && (
            <button
              className="remote-prompt-cancel"
              title="Take pages whose link no longer opens off this list"
              onClick={() => {
                forgetPages(new Set(unavailable.keys()));
                setUnavailable(new Map());
              }}
            >
              Clear unavailable ({unavailable.size})
            </button>
          )}
          <button
            className="remote-prompt-cancel"
            title="Drop pages deleted elsewhere and check the files they came from"
            disabled={refreshing}
            onClick={() => void refresh(false)}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button className="remote-prompt-cancel" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
