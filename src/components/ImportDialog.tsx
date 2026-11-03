import { useEffect, useState } from "react";
import { useStore } from "../store";
import { publishTargets } from "../ipc";
import type { PublishTarget } from "../ipc";
import {
  fileForPage,
  importFromLink,
  importTargets,
  linkWhenSaved,
  localLinksFor,
  pageForLink,
  replaceDocText,
} from "../publish";
import { restoreLinks } from "../docLinks";
import { firstH1 } from "../pageIndex";
import { keyForDoc } from "../annotations";
import { basename } from "../types";

const LINK_KEY = "importKeepLinked";
const WHERE_KEY = "importSaveWhere";

type Where = "mac" | "remote";

/** A file name from the page's title: `Title.md`, without characters paths can't hold. */
function fileNameFor(markdown: string, fallback: string): string {
  const title = (firstH1(markdown) ?? fallback)
    .replace(/[/\\:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 120);
  return `${title || fallback}.md`;
}

/**
 * File → Import from Link…: paste a page's link (any publish target with an
 * `import` list, e.g. a doc first written in the browser), get it as a new
 * markdown document, and save it on this Mac or a remote host. Linked (the
 * default), the next Publish updates that page instead of making a new one.
 * A page published from a file here goes back into that file instead.
 */
export function ImportDialog() {
  const open = useStore((s) => s.importOpen);
  return open ? <Import /> : null;
}

function Import() {
  const close = () => useStore.getState().setImportOpen(false);
  const [targets, setTargets] = useState<PublishTarget[] | null>(null);
  const [link, setLink] = useState("");
  const [keepLinked, setKeepLinked] = useState(() => localStorage.getItem(LINK_KEY) !== "0");
  const [where, setWhere] = useState<Where>(() => (localStorage.getItem(WHERE_KEY) === "remote" ? "remote" : "mac"));
  const [busy, setBusy] = useState(false);
  const [asNew, setAsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    publishTargets()
      .then(setTargets)
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const importable = targets ? importTargets(targets) : [];
  const labels = importable.map((t) => t.label).join(" or ");
  // Published from a file here: pull the page's changes back into that file.
  const source = targets ? pageForLink(targets, link) : null;
  const sourceFile = source ? fileForPage(source.target.id, source.id) : null;
  const updating = !!sourceFile && !asNew;
  const fileLabel = sourceFile
    ? `${basename(sourceFile)}${sourceFile.startsWith("/") ? "" : ` (${sourceFile.split(":")[0]})`}`
    : "";

  const run = async () => {
    if (!targets || !link.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const page = await importFromLink(targets, link);
      const s = useStore.getState();
      if (updating && sourceFile) {
        await s.openPaths([sourceFile]);
        const doc = Object.values(useStore.getState().docs).find((d) => keyForDoc(d) === sourceFile);
        if (!doc) throw new Error(`Couldn't open ${fileLabel}.`);
        // Links to pages published from files here point at those files again.
        const markdown = restoreLinks(page.markdown, localLinksFor(doc, page.target.id));
        if (!(await replaceDocText(doc.id, markdown))) throw new Error(`Couldn't open ${fileLabel}.`);
        close();
        return;
      }
      const docId = s.newDocWith(fileNameFor(page.markdown, page.id), page.markdown);
      if (keepLinked) linkWhenSaved(docId, page.target, page.url);
      close();
      // Saving gives it a place on disk, which is what a link is kept by.
      if (where === "remote") s.setRemoteBrowser("save");
      else await s.saveDoc(docId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const pick = (next: Where) => {
    setWhere(next);
    localStorage.setItem(WHERE_KEY, next);
  };

  return (
    <div className="settings-backdrop" onClick={() => !busy && close()}>
      <div className="remote-prompt publish-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="publish-head">
          <span className="remote-prompt-label">Import from Link</span>
        </div>

        {targets && importable.length === 0 ? (
          <p className="rb-status">
            None of your publish targets can import yet. Add an <code>import</code> list to one in publish.json (see
            docs/PUBLISHING.md).
          </p>
        ) : (
          <>
            <input
              className="remote-prompt-input"
              placeholder={labels ? `Paste a ${labels} link` : "Paste a link"}
              value={link}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              disabled={busy}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void run();
                }
              }}
            />

            {sourceFile && (
              <div className="publish-checks">
                {updating && (
                  <p className="publish-status">
                    Published from <strong>{fileLabel}</strong>. Import puts the page's text into that file as unsaved
                    changes: review them, then ⌘S to keep them or ⌘Z to undo.
                  </p>
                )}
                <label className="publish-asnew">
                  <input type="checkbox" checked={asNew} disabled={busy} onChange={(e) => setAsNew(e.target.checked)} />
                  Import as a new file instead
                </label>
              </div>
            )}

            {!updating && (
              <div className="publish-checks">
                <label className="publish-asnew">
                  <input
                    type="checkbox"
                    checked={keepLinked}
                    disabled={busy}
                    onChange={(event) => {
                      setKeepLinked(event.target.checked);
                      localStorage.setItem(LINK_KEY, event.target.checked ? "1" : "0");
                    }}
                  />
                  Publish updates this page
                </label>
                <label className="publish-asnew">
                  <input type="radio" checked={where === "mac"} disabled={busy} onChange={() => pick("mac")} />
                  Save on this Mac
                </label>
                <label className="publish-asnew">
                  <input type="radio" checked={where === "remote"} disabled={busy} onChange={() => pick("remote")} />
                  Save on a remote host
                </label>
              </div>
            )}

            {keepLinked && !updating && (
              <p className="publish-status">
                Publishing replaces the whole page with your markdown. What markdown can't hold (comments on text that
                changed, cell colors, column widths) may be lost.
              </p>
            )}
          </>
        )}

        {error && <p className="publish-status rb-error">{error}</p>}

        <div className="remote-prompt-actions">
          <span className="rb-where">{busy ? "Importing…" : ""}</span>
          <button className="remote-prompt-cancel" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="remote-prompt-open"
            onClick={() => void run()}
            disabled={busy || !link.trim() || importable.length === 0}
          >
            {updating ? "Update file" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
