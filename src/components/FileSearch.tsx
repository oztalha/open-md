import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings";
import { getRecents } from "../recent";
import { parseOpenSpec, remoteUrl, isGithubHost } from "../remote";
import { getEditorView } from "../editor/registry";
import { revealLine } from "../reveal";
import { readRemoteFile, searchFiles } from "../ipc";
import { basename, displayTitle, isCodePath } from "../types";
import { matcher, searchText, snippet } from "../fileSearch";
import type { LineHit, SearchOptions } from "../fileSearch";

const OPTS_KEY = "fileSearchOptions";
const SCOPE_KEY = "fileSearchScope";

type Scope = "open" | "all";

interface FileResult {
  /** Order in the list: open files first (tab order), then recents. */
  order: number;
  label: string;
  where: string;
  docId?: string;
  host?: string;
  path: string;
  hits: LineHit[];
}

function loadOpts(): SearchOptions {
  try {
    return { caseSensitive: false, wholeWord: false, regex: false, ...JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") };
  } catch {
    return { caseSensitive: false, wholeWord: false, regex: false };
  }
}

/**
 * Search in Files (⇧⌘F) at the top of the Files tab: a word or phrase across
 * the open documents (in memory, unsaved edits included) and, optionally, the
 * recent files (one `grep` per host). While there's a query, the results take
 * the place of the file lists (`children`).
 */
export function FileSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<SearchOptions>(loadOpts);
  const [scope, setScope] = useState<Scope>(() => (localStorage.getItem(SCOPE_KEY) === "open" ? "open" : "all"));
  const [results, setResults] = useState<FileResult[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const request = useRef(0);

  // ⇧⌘F focuses the box; pressed again in the box, it closes the search.
  const tick = useStore((s) => s.fileSearchTick);
  useEffect(() => {
    if (tick) {
      input.current?.focus();
      input.current?.select();
    }
  }, [tick]);
  useEffect(() => {
    const close = () => {
      setQuery("");
      input.current?.blur();
    };
    window.addEventListener("mdv-file-search-close", close);
    return () => window.removeEventListener("mdv-file-search-close", close);
  }, []);

  const re = matcher(query, opts);
  const invalid = !!query && !re;

  useEffect(() => {
    const id = ++request.current;
    if (!re) {
      setResults([]);
      setProblems([]);
      setPending(0);
      return;
    }
    const timer = setTimeout(() => void run(id), 250);
    return () => clearTimeout(timer);
    // `re` follows query + opts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, scope]);

  const run = async (id: number) => {
    const live = () => id === request.current;
    const s = useStore.getState();
    const found: FileResult[] = [];
    const add = (r: FileResult) => {
      if (!live() || r.hits.length === 0) return;
      found.push(r);
      found.sort((a, b) => a.order - b.order);
      setResults([...found]);
    };
    setResults([]);
    setProblems([]);

    // Open documents: in memory.
    const openSpecs = new Set<string>();
    s.tabs.forEach((docId, order) => {
      const doc = s.docs[docId];
      if (!doc || doc.image) return;
      openSpecs.add(doc.remote ? remoteUrl(doc.remote) : (doc.path ?? ""));
      const text = getEditorView(doc.id)?.state.doc.toString() ?? doc.content;
      add({
        order,
        label: displayTitle(doc),
        where: doc.remote ? doc.remote.host : doc.path ? "local" : "unsaved",
        docId: doc.id,
        host: doc.remote?.host,
        path: doc.remote?.path ?? doc.path ?? "",
        hits: searchText(text, matcher(query, opts)!),
      });
    });
    if (scope !== "all") return setPending(0);

    // Recent files: grouped by where they live, one search per group.
    const defaultHost = useSettings.getState().settings.defaultRemoteHost ?? "";
    const groups = new Map<string, { host: string | null; files: { path: string; order: number; label: string }[] }>();
    getRecents().forEach((entry, i) => {
      if (openSpecs.has(entry.spec)) return;
      const spec = parseOpenSpec(entry.spec, defaultHost);
      const host = spec.kind === "remote" ? spec.ref.host : null;
      const path = spec.kind === "remote" ? spec.ref.path : spec.path;
      const key = host ?? "";
      const group = groups.get(key) ?? { host, files: [] };
      group.files.push({ path, order: 1000 + i, label: basename(path) });
      groups.set(key, group);
    });
    setPending(groups.size);
    await Promise.all(
      [...groups.values()].map(async ({ host, files }) => {
        try {
          if (host && isGithubHost(host)) {
            // GitHub files: read through the API (no grep there).
            await Promise.all(
              files.map(async (f) => {
                const text = await readRemoteFile(host, f.path).catch(() => "");
                add({ ...f, where: host, host, hits: searchText(text, matcher(query, opts)!) });
              }),
            );
          } else {
            const hits = await searchFiles(host, files.map((f) => f.path), query, opts);
            for (const f of files) {
              add({ ...f, where: host ?? "local", host: host ?? undefined, hits: hits.filter((h) => h.path === f.path) });
            }
          }
        } catch (err) {
          if (live()) setProblems((p) => [...p, `${host ?? "This Mac"}: ${err instanceof Error ? err.message : String(err)}`]);
        } finally {
          if (live()) setPending((n) => n - 1);
        }
      }),
    );
  };

  const toggle = (key: keyof SearchOptions) => {
    const next = { ...opts, [key]: !opts[key] };
    setOpts(next);
    localStorage.setItem(OPTS_KEY, JSON.stringify(next));
  };
  const changeScope = (next: Scope) => {
    setScope(next);
    localStorage.setItem(SCOPE_KEY, next);
  };

  const openHit = (r: FileResult, line: number) => {
    const s = useStore.getState();
    if (r.docId && s.docs[r.docId]) {
      s.selectTab(r.docId);
      revealLine(r.docId, line, isCodePath(r.path));
    } else if (r.host) {
      void s.openRemote(r.host, r.path, line);
    } else {
      void s.openPaths([`${r.path}:${line}`]);
    }
  };

  const total = results.reduce((n, r) => n + r.hits.length, 0);
  const status = invalid
    ? "Bad pattern"
    : pending > 0
      ? `Searching… ${total ? `${total} so far` : ""}`
      : total
        ? `${total} match${total === 1 ? "" : "es"} in ${results.length} file${results.length === 1 ? "" : "s"}`
        : "No matches";

  return (
    <>
      <div className="file-search">
        <div className={`find-field file-search-field${invalid ? " invalid" : ""}`}>
          <input
            ref={input}
            className="file-search-input"
            placeholder="Search in files"
            value={query}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
                input.current?.blur();
              }
            }}
          />
          <button className={`find-opt${opts.caseSensitive ? " on" : ""}`} data-tip="Match case" onClick={() => toggle("caseSensitive")}>
            Aa
          </button>
          <button className={`find-opt${opts.wholeWord ? " on" : ""}`} data-tip="Whole word" onClick={() => toggle("wholeWord")}>
            <span className="find-word">ab</span>
          </button>
          <button className={`find-opt${opts.regex ? " on" : ""}`} data-tip="Regular expression" onClick={() => toggle("regex")}>
            .*
          </button>
        </div>
        {query && (
          <div className="file-search-meta">
            <div className="file-search-scope" role="radiogroup">
              <button className={scope === "open" ? "on" : ""} onClick={() => changeScope("open")}>
                Open
              </button>
              <button className={scope === "all" ? "on" : ""} onClick={() => changeScope("all")}>
                Open + Recent
              </button>
            </div>
            <span className="file-search-status">{status}</span>
          </div>
        )}
      </div>
      {query ? (
        <div className="file-search-results">
          {re &&
            results.map((r) => (
              <div key={`${r.where}:${r.path}:${r.docId ?? ""}`} className="file-search-file">
                <div className="file-search-file-name" title={r.host ? `${r.host}:${r.path}` : r.path}>
                  <span className="sidebar-name">{r.label}</span>
                  <span className="sidebar-hint">
                    {r.docId ? "open · " : ""}
                    {r.where} · {r.hits.length}
                    {r.hits.length >= 50 ? "+" : ""}
                  </span>
                </div>
                {r.hits.map((h) => (
                  <button key={h.line} className="file-search-hit" onClick={() => openHit(r, h.line)}>
                    <span className="file-search-line">{h.line}</span>
                    <span className="file-search-text">
                      {snippet(h.text, re).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          {problems.map((p) => (
            <p key={p} className="file-search-problem">
              {p}
            </p>
          ))}
        </div>
      ) : (
        children
      )}
    </>
  );
}
