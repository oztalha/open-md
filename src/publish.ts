import type { Doc } from "./types";
import { basename, displayTitle } from "./types";
import { keyForDoc } from "./annotations";
import { useStore } from "./store";
import { buildExportHtml, standalonePage } from "./export";
import { getEditorView } from "./editor/registry";
import {
  copyToClipboard,
  gistDelete,
  gistExists,
  mcpCall,
  pagesDelete,
  pagesBase,
  pagesCommit,
  pagesIndexGet,
  pagesPasswordGet,
  pagesPasswordSet,
  mcpClose,
  mcpOpen,
  publishCommand,
  publishGist,
  publishStepCommand,
  publishTargets,
  readRemoteFile,
  readTextFile,
  readRemoteBytes,
  publishUploadImage,
  publishWriteTempBytes,
  realPath,
  remoteStat,
  writePublishTemp,
} from "./ipc";
import { isGithubHost, splitGithubSpec } from "./remote";
import { encryptPage, MIN_PASSWORD, newPageId } from "./pageCrypt";
import { INDEX_CSS, firstH1, parseIndex, renderIndexBody, withEntry, withoutEntry } from "./pageIndex";
import type { IndexEntry } from "./pageIndex";
import { localDocLinks, localImageRefs, resolveLink, rewriteImages, rewriteLinks } from "./docLinks";
import { idFromLink } from "./publishSearch";
import type { McpResult, PublishStep, PublishTarget } from "./ipc";

/**
 * Publishing a document to a target from ~/.config/open-md/publish.json.
 * The first publish to a target runs its `create` steps; later ones run
 * `update` against the saved id, so the published link stays the same.
 */

export interface PublishRecord {
  id: string;
  url: string;
  at: number;
  /** GitHub documents: republish when the file changes on GitHub. */
  sync?: boolean;
  /** GitHub documents: the blob sha last published by sync. */
  sha?: string;
  /** Gists: the gh account that owns it (only it can update it); unset = gh's active one. */
  account?: string;
  /** GitHub Pages: published without a password. */
  open?: boolean;
  /** GitHub Pages: listed on the account's index page. */
  listed?: boolean;
}

const STORAGE_KEY = "published";

type Records = Record<string, Record<string, PublishRecord>>;

function loadRecords(): Records {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Records;
  } catch {
    return {};
  }
}

/**
 * Where (and at which link) a document has been published, by target id.
 * Reads localStorage, which React can't see: components pass the store's
 * `publishTick` as `version` so the React Compiler doesn't reuse a stale result.
 */
export function publishedFor(doc: Doc | undefined, _version = 0): Record<string, PublishRecord> {
  const records = loadRecords();
  // The real-path record wins over one saved under another path to the file.
  return recordKeys(doc).reduceRight<Record<string, PublishRecord>>(
    (acc, key) => ({ ...acc, ...(records[key] ?? {}) }),
    {},
  );
}

/**
 * Real paths, by document key: a file reached through a symlinked folder
 * (`/home/me/x.md` and `/local/home/me/x.md`) is one file, so it has one
 * publish record and one link. Filled in by `resolveRealKey`.
 */
const realKeys = new Map<string, string>();

/** The keys a document's records may be under: its real path first. */
function recordKeys(doc: Doc | undefined): string[] {
  const key = keyForDoc(doc);
  if (!key) return [];
  const real = realKeys.get(key);
  return real && real !== key ? [real, key] : [key];
}

/** Where a document's records are saved: its real path once known. */
function recordKey(doc: Doc): string | null {
  return recordKeys(doc)[0] ?? null;
}

/**
 * Look up a document's real path (once per key), so its records match
 * however the file was opened. Re-renders views when it differs.
 */
export async function resolveRealKey(doc: Doc | undefined): Promise<void> {
  const key = keyForDoc(doc);
  if (!doc || !key || realKeys.has(key) || splitGithubSpec(key)) return;
  const path = doc.remote?.path ?? doc.path;
  if (!path) return;
  let real = path;
  try {
    real = await realPath(doc.remote?.host ?? null, path);
  } catch {
    // offline: match by the path as opened, try again next time
    return;
  }
  const realKey = doc.remote ? `${doc.remote.host}:${real}` : real;
  realKeys.set(key, realKey);
  if (realKey !== key) useStore.getState().bumpPublished();
}

/** The most recently published link for a document, if any. */
export function latestPublished(doc: Doc | undefined, version = 0): PublishRecord | undefined {
  return Object.values(publishedFor(doc, version)).sort((x, y) => y.at - x.at)[0];
}

/** One publish (create or update), kept so a link can be traced to its file. */
export interface PublishLogEntry {
  /** Where the document lives: a local path, or `host:path`. */
  key: string;
  host?: string;
  path: string;
  title: string;
  target: string;
  targetLabel: string;
  id: string;
  url: string;
  at: number;
  updated: boolean;
  /** GitHub Pages: published without a password. */
  open?: boolean;
}

const LOG_KEY = "publishLog";

/**
 * Every publish, oldest first. Unlike the per-document records (latest link
 * per target only), nothing here is overwritten. The first read seeds it from
 * those records, so links published before the log existed show up too.
 */
function loadLog(): PublishLogEntry[] {
  const raw = localStorage.getItem(LOG_KEY);
  if (raw) {
    try {
      // Publishes from before pages could go without a password.
      return (JSON.parse(raw) as PublishLogEntry[]).map((e) =>
        e.targetLabel === "Password-protected page" ? { ...e, targetLabel: "GitHub Pages" } : e,
      );
    } catch {
      return [];
    }
  }
  const seeded: PublishLogEntry[] = [];
  for (const [key, byTarget] of Object.entries(loadRecords())) {
    for (const [target, rec] of Object.entries(byTarget)) {
      seeded.push({ ...whereFromKey(key), key, title: "", target, targetLabel: target, id: rec.id, url: rec.url, at: rec.at, updated: false });
    }
  }
  seeded.sort((a, b) => a.at - b.at);
  localStorage.setItem(LOG_KEY, JSON.stringify(seeded));
  return seeded;
}

/** A record key back to host/path (`host:/path`, `host:~/path`, or a local path). */
function whereFromKey(key: string): { host?: string; path: string } {
  const m = /^([^/:]+):((?:\/|~).*)$/.exec(key);
  return m ? { host: m[1], path: m[2] } : { path: key };
}

/** Drop pages that no longer exist from Published Documents. */
export function forgetPublished(gone: (entry: PublishLogEntry) => boolean): void {
  const log = loadLog();
  const kept = log.filter((e) => !gone(e));
  if (kept.length === log.length) return;
  localStorage.setItem(LOG_KEY, JSON.stringify(kept));
  useStore.getState().bumpPublished();
}

function appendLog(entry: PublishLogEntry): void {
  const log = loadLog();
  // The very first publish seeds the log from the records, which already
  // hold this one (untitled, a moment ago): replace it instead of adding a
  // second entry.
  const seeded = log.findIndex((e) => e.url === entry.url && !e.title && Math.abs(e.at - entry.at) < 5000);
  if (seeded >= 0) log.splice(seeded, 1);
  log.push(entry);
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}

/**
 * Every publish, as one entry per published page (newest first), with when it
 * was first published and how often it was updated since. `_version`: see
 * `publishedFor`.
 */
export function publishedPages(
  _version = 0,
): (PublishLogEntry & { first: number; updates: number })[] {
  const byUrl = new Map<string, PublishLogEntry & { first: number; updates: number }>();
  for (const e of loadLog()) {
    const page = byUrl.get(e.url);
    if (!page) byUrl.set(e.url, { ...e, first: e.at, updates: 0 });
    else byUrl.set(e.url, { ...e, title: e.title || page.title, first: page.first, updates: page.updates + 1 });
  }
  return [...byUrl.values()].sort((a, b) => b.at - a.at);
}

function saveRecord(doc: Doc, targetId: string, record: PublishRecord): void {
  const key = recordKey(doc);
  if (!key) return; // unsaved scratch docs have no stable identity
  const records = loadRecords();
  // Saved under the real path; an older record under another path moves there.
  for (const other of recordKeys(doc).slice(1)) {
    if (records[other]?.[targetId]) {
      delete records[other][targetId];
      if (Object.keys(records[other]).length === 0) delete records[other];
    }
  }
  records[key] = { ...(records[key] ?? {}), [targetId]: record };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/** Forget a document's record for a target, under every key it may be saved. */
/** The document's page on `targetId` is gone (deleted, or its link forgotten). */
function forgetRecord(doc: Doc, targetId: string): void {
  const url = publishedFor(doc)[targetId]?.url;
  for (const key of recordKeys(doc)) removeRecord(key, targetId);
  if (url) forgetPublished((e) => e.url === url);
}

function removeRecord(key: string, targetId: string): void {
  const records = loadRecords();
  if (!records[key]?.[targetId]) return;
  delete records[key][targetId];
  if (Object.keys(records[key]).length === 0) delete records[key];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  useStore.getState().setPublishError(publishErrorKey(key, targetId), null);
  useStore.getState().bumpPublished();
}

const verified = new Set<string>();

/**
 * Forget gists that were deleted on github.com, so the document no longer
 * shows as published and Publish creates a new one. Once per document per
 * session unless `force`; if GitHub can't be reached, the links are kept.
 */
export async function verifyPublished(doc: Doc | undefined, force = false): Promise<void> {
  const key = keyForDoc(doc);
  if (!key || (!force && verified.has(key))) return;
  verified.add(key);
  const records = Object.entries(publishedFor(doc));
  if (records.length === 0) return;
  let targets: PublishTarget[];
  try {
    targets = await publishTargets();
  } catch {
    return; // a broken publish.json shows its error in the dialog
  }
  for (const [targetId, rec] of records) {
    if (targets.find((t) => t.id === targetId)?.kind !== "gist") continue;
    try {
      if (!(await gistExists(rec.id, rec.account ?? null))) forgetRecord(doc!, targetId);
    } catch {
      // offline or gh trouble: keep the link
    }
  }
}

/**
 * Take a document down from a target: delete the gist or protected page, then
 * forget the record. Other targets have no delete step, so only the record is
 * forgotten (the caller says so). Linked documents stay published.
 */
export async function unpublish(
  doc: Doc,
  target: PublishTarget,
): Promise<"deleted" | "forgotten"> {
  const key = keyForDoc(doc);
  const rec = publishedFor(doc)[target.id];
  if (!key || !rec) return "forgotten";
  let result: "deleted" | "forgotten" = "forgotten";
  if (target.kind === "gist") {
    await gistDelete(rec.id, rec.account ?? null);
    result = "deleted";
  } else if (target.kind === "pages") {
    await pagesDelete(rec.id, rec.account ?? null);
    result = "deleted";
  }
  forgetRecord(doc, target.id);
  // Even if this Mac didn't list it: another Mac may have.
  if (target.kind === "pages") {
    try {
      await updateIndex(rec.account, (entries) => withoutEntry(entries, rec.id));
    } catch (err) {
      throw new Error(
        `Deleted the page, but couldn't take it off your index page: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/** Turn "keep in sync with GitHub" on or off for one published copy. */
export function setSync(doc: Doc, targetId: string, on: boolean): void {
  const rec = publishedFor(doc)[targetId];
  if (!rec) return;
  // No sha when turning on: the first sync then republishes from GitHub, so
  // the published copy matches GitHub even if it was published with local edits.
  saveRecord(doc, targetId, { ...rec, sync: on || undefined, sha: undefined });
  const key = keyForDoc(doc);
  if (key) useStore.getState().setPublishError(publishErrorKey(key, targetId), null);
  useStore.getState().bumpPublished();
  if (on) void syncGithubPublished();
}

export function isGithubDoc(doc: Doc | undefined): boolean {
  return !!doc?.remote && isGithubHost(doc.remote.host);
}

/** Fill `{name}` placeholders in every string inside `value`. Unknown names stay as-is. */
function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

function resultText(result: McpResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

/** A tool reply as data: structured content, else JSON text, else the raw text. */
function resultData(result: McpResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Read a dotted path ("result.version.id") out of a reply. */
function pick(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

async function runSteps(
  target: PublishTarget,
  update: boolean,
  vars: Record<string, string>,
): Promise<void> {
  const steps: PublishStep[] = update ? target.update : target.create;
  // Started on the first tool step, so command-only lists don't spawn a server.
  let session: number | undefined;
  try {
    for (const [index, step] of steps.entries()) {
      let data: unknown;
      if (step.run) {
        data = await publishStepCommand(target.id, update, index, vars);
      } else {
        session ??= await mcpOpen(target.id);
        const result = await mcpCall(session, step.tool, fill(step.args ?? {}, vars));
        if (result.isError) {
          throw new Error(`${target.label} (${step.tool}): ${resultText(result) || "failed"}`);
        }
        data = resultData(result);
      }
      for (const [name, path] of Object.entries(step.save ?? {})) {
        const value = pick(data, path);
        if (value != null && value !== "") vars[name] = String(value);
      }
    }
  } finally {
    if (session !== undefined) void mcpClose(session);
  }
}

export interface PublishOutcome {
  url: string;
  /** Protected pages: in the page once the host serves this version (see pagesLive). */
  marker?: string;
  updated: boolean;
  /** Linked documents published along with it. */
  linked: number;
  /** Linked documents that couldn't be published, with why. */
  skipped: string[];
  /** GitHub Pages: the index page, when this page is listed on it. */
  indexUrl?: string;
  /** GitHub Pages: the page is published, but the index couldn't be updated. */
  indexError?: string;
}

/**
 * Link a document to a page published before (e.g. from another Mac, or
 * before its record was lost), so the next publish updates that page instead
 * of creating a new one. Throws if the link isn't one of this target's pages.
 */
export function linkExistingPage(doc: Doc, target: PublishTarget, link: string): PublishRecord {
  const id = idFromLink(link, target);
  if (!id) throw new Error(`That doesn't look like a ${target.label} link.`);
  const url =
    target.kind === "gist"
      ? `https://gist.github.com/${id}`
      : target.kind === "command"
        ? id
        : target.kind === "pages"
          ? link.trim().replace(/[?#].*$/, "")
          : String(fill(target.urlTemplate ?? "", { id }));
  const record = { id, url, at: Date.now() };
  saveRecord(doc, target.id, record);
  useStore.getState().bumpPublished();
  return record;
}

/** The text to publish: the live editor (unsaved edits included), else the doc. */
function liveMarkdown(doc: Doc): string {
  const view = getEditorView(doc.id);
  return view ? view.state.doc.toString() : doc.content;
}

/** A local markdown file a document links to, and the hrefs that point at it. */
export interface LinkedDoc {
  doc: Doc;
  hrefs: string[];
}

/**
 * The other local markdown files a document links to (one hop), resolved like
 * a click in the preview. A remote document's links stay on its host.
 */
export function linkedDocs(doc: Doc | undefined): LinkedDoc[] {
  if (!doc || doc.image) return [];
  const where = doc.remote?.path ?? doc.path;
  const baseDir = where ? where.slice(0, where.lastIndexOf("/")) : null;
  const self = keyForDoc(doc);
  const byKey = new Map<string, LinkedDoc>();
  for (const href of localDocLinks(liveMarkdown(doc))) {
    const path = resolveLink(baseDir, href);
    if (!path) continue;
    const linked: Doc = {
      id: "",
      path: doc.remote ? null : path,
      remote: doc.remote ? { ...doc.remote, path } : null,
      title: path.slice(path.lastIndexOf("/") + 1),
      content: "",
      saved: "",
    };
    const key = keyForDoc(linked);
    if (!key || key === self) continue;
    const entry = byKey.get(key);
    if (entry) entry.hrefs.push(href);
    else byKey.set(key, { doc: linked, hrefs: [href] });
  }
  return [...byKey.values()];
}

/** A linked file's text: from its open tab if it has one (unsaved edits too). */
async function readLinked(linked: Doc): Promise<string> {
  const key = keyForDoc(linked);
  const open = Object.values(useStore.getState().docs).find((d) => keyForDoc(d) === key);
  if (open) return liveMarkdown(open);
  return linked.remote ? readRemoteFile(linked.remote.host, linked.remote.path) : readTextFile(linked.path!);
}

/** Publish (or republish) one document's text to a target and record the link. */
async function publishText(
  doc: Doc,
  markdown: string,
  target: PublishTarget,
  asNew: boolean,
  extra: {
    sha?: string;
    account?: string;
    password?: string;
    open?: boolean;
    listed?: boolean;
    sync?: boolean;
  } = {},
  batch?: PagesBatch,
): Promise<{
  id: string;
  url: string;
  title: string;
  updated: boolean;
  marker?: string;
  account?: string;
  open: boolean;
  listed: boolean;
}> {
  await resolveRealKey(doc); // match records however the file was opened
  const title = displayTitle(doc).replace(
    /\.(md|markdown|mdown|mkdn|mkd|txt)$/i,
    "",
  );
  const html = target.format === "html";
  const contents = html ? await buildExportHtml(markdown, title, { footer: true }) : markdown;
  const previous = asNew ? undefined : publishedFor(doc)[target.id];
  let id = "";
  let url = "";
  let marker: string | undefined;
  // An update must come from the owner (gist, pages repo); a new one uses the chosen account.
  const owned = target.kind === "gist" || target.kind === "pages";
  const account = owned
    ? previous
      ? previous.account
      : extra.account
    : undefined;

  // Sync and linked documents without a choice keep the page as it was.
  const wasOpen = !!previous?.open;
  const open = target.kind === "pages" && (extra.open ?? wasOpen);
  // Protection never changes in place: a link shared as password-protected
  // must never start showing the page in plain text (and the reverse would
  // leave the plain text in the repo's history). Switching makes a new page
  // with a new link; the old one stays until it's unpublished.
  const samePage = target.kind !== "pages" || open === wasOpen;
  const pageId = samePage ? previous?.id : undefined;
  // GitHub Pages files go up with the rest of the publish (one commit, one
  // build); on their own (sync) they go up right here.
  const own = target.kind === "pages" && !batch ? new PagesBatch() : undefined;
  const pages = batch ?? own;
  if (target.kind === "pages" && open) {
    ({ id, url, marker } = await publishOpen(markdown, title, pageId, account, pages!));
  } else if (target.kind === "pages") {
    ({ id, url, marker } = await publishProtected(
      doc,
      markdown,
      title,
      pageId,
      account,
      extra.password,
      pages!,
    ));
  } else {
    const file = await writePublishTemp(
      `${title || "document"}.${html ? "html" : "md"}`,
      contents,
    );
    ({ id, url } = await publishTo(
      doc,
      target,
      file,
      title,
      contents,
      previous,
      account,
    ));
  }

  const listed = !!(extra.listed ?? previous?.listed);
  // Recorded once it's up (for GitHub Pages, after the commit).
  const record = () => {
    saveRecord(doc, target.id, {
      id,
      url,
      at: Date.now(),
      sync: (extra.sync ?? previous?.sync) || undefined,
      sha: extra.sha ?? previous?.sha,
      account,
      open: open || undefined,
      listed: listed || undefined,
    });
    const key = recordKey(doc);
    if (key) {
      appendLog({
        key,
        host: doc.remote?.host,
        path: doc.remote?.path ?? doc.path ?? key,
        title,
        target: target.id,
        targetLabel: target.label,
        id,
        url,
        at: Date.now(),
        updated: !!previous && samePage,
        open: open || undefined,
      });
    }
    useStore.getState().bumpPublished();
  };
  if (pages) pages.afterCommit(record);
  else record();
  if (own) await own.commit();
  return { id, url, title, updated: !!previous && samePage, marker, account, open, listed };
}

/**
 * A public page: the rendered page as it is, under a random name like a
 * protected one. `marker` (random, in the page) tells when the host serves it.
 */
async function publishOpen(
  markdown: string,
  title: string,
  existingId: string | undefined,
  account: string | undefined,
  batch: PagesBatch,
): Promise<{ id: string; url: string; marker: string }> {
  const pageId = existingId ?? newPageId();
  const marker = newPageId();
  const page = await buildExportHtml(markdown, title, {
    footer: true,
    head: `<meta name="md-viewer-publish" content="${marker}">`,
  });
  const url = await batch.add(account, pageId, await writePublishTemp(`${pageId}.html`, page));
  return { id: pageId, url, marker };
}

/**
 * GitHub Pages files of one publish, written in a single commit: each commit
 * starts a site build that cancels the one before, so one per file made a
 * publish with linked documents wait for many. Records and passwords are
 * saved once the commit is in.
 */
class PagesBatch {
  private files = new Map<string, { name: string; file: string }[]>();
  private bases = new Map<string, string>();
  private done: (() => void | Promise<void>)[] = [];

  /** Stage `<id>.html` (or the index, with id "index"); returns its link. */
  async add(account: string | undefined, id: string, file: string): Promise<string> {
    const key = account ?? "";
    // The link first: a page that can't get one isn't staged.
    const base = this.bases.get(key) ?? (await pagesBase(account ?? null));
    this.bases.set(key, base);
    const list = this.files.get(key) ?? [];
    this.files.set(key, [...list.filter((f) => f.name !== `${id}.html`), { name: `${id}.html`, file }]);
    return id === "index" ? base : `${base}${id}.html`;
  }

  /** Run `fn` once the commit is in. */
  afterCommit(fn: () => void | Promise<void>): void {
    this.done.push(fn);
  }

  async commit(): Promise<void> {
    for (const [account, files] of this.files) await pagesCommit(files, account || null);
    for (const fn of this.done) await fn();
  }
}

/**
 * Change the account's index page: read it from the repo (so every Mac edits
 * the same list), apply `change`, write it back if that changed anything.
 * Returns its link.
 */
async function updateIndex(
  account: string | undefined,
  change: (entries: IndexEntry[]) => IndexEntry[],
  batch?: PagesBatch,
): Promise<string> {
  const { url, html } = await pagesIndexGet(account ?? null);
  const entries = parseIndex(html);
  const next = change(entries);
  if (html == null && next.length === 0) return url;
  const owner = new URL(url).hostname.split(".")[0];
  const page = standalonePage(renderIndexBody(next, owner), `Pages by ${owner}`, { css: INDEX_CSS, footer: true });
  // Compared as a whole page, so an index made by an older version picks up
  // the current design on the next publish.
  if (html === page) return url;
  const file = await writePublishTemp("index.html", page);
  if (batch) await batch.add(account, "index", file);
  else await pagesCommit([{ name: "index.html", file }], account ?? null);
  return url;
}

/** Whether a page is on the account's index page now (the repo's copy). */
export async function isListed(id: string, account: string | undefined): Promise<boolean> {
  const { html } = await pagesIndexGet(account ?? null);
  return parseIndex(html).some((e) => e.id === id);
}

/**
 * A password-protected page: the rendered page, encrypted here (the plaintext
 * never leaves the app), uploaded under a random name. Without a password
 * given (sync, republish), the one saved in the Keychain is used.
 */
async function publishProtected(
  doc: Doc,
  markdown: string,
  title: string,
  existingId: string | undefined,
  account: string | undefined,
  given: string | undefined,
  batch: PagesBatch,
): Promise<{ id: string; url: string; marker: string }> {
  const password =
    given ?? (existingId ? await pagesPasswordGet(existingId) : null);
  if (!password)
    throw new Error(
      `No saved password for “${displayTitle(doc)}”. Publish it from the Publish dialog.`,
    );
  if (password.length < MIN_PASSWORD)
    throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const pageId = existingId ?? newPageId();
  const { page, marker } = await encryptPage(await buildExportHtml(markdown, title, { footer: true }), password, pageId);
  const url = await batch.add(account, pageId, await writePublishTemp(`${pageId}.html`, page));
  batch.afterCommit(() => pagesPasswordSet(pageId, password));
  return { id: pageId, url, marker };
}

async function publishTo(
  doc: Doc,
  target: PublishTarget,
  file: string,
  title: string,
  contents: string,
  previous: PublishRecord | undefined,
  account: string | undefined,
): Promise<{ id: string; url: string }> {
  let id = "";
  let url = "";
  if (target.kind === "gist") {
    try {
      ({ id, url } = await publishGist(
        target.id,
        file,
        title,
        previous?.id ?? null,
        account ?? null,
      ));
    } catch (err) {
      // Deleted on github.com: forget it, so the next publish makes a new gist.
      const key = keyForDoc(doc);
      if (
        previous &&
        key &&
        !(await gistExists(previous.id, account ?? null).catch(() => true))
      ) {
        forgetRecord(doc, target.id);
        throw new Error(
          "This gist was deleted on GitHub. Publish again to create a new one.",
        );
      }
      throw err;
    }
  } else if (target.kind === "command") {
    ({ id, url } = await publishCommand(
      target.id,
      file,
      title,
      previous?.id ?? null,
    ));
  } else {
    const updating = !!previous && target.update.length > 0;
    // Local images are uploaded to the page, so the published copy shows them.
    // That needs the page's id: a new page is created first, then updated.
    const images = target.uploadsImages && target.format !== "html" ? localImageRefs(contents) : [];
    let vars: Record<string, string> = { file, title, content: contents };
    if (updating) {
      const withImages = await uploadImages(doc, target, previous.id, contents, images);
      vars = { ...vars, id: previous.id, content: withImages, file: await writePublishTemp(basename(file), withImages) };
    }
    await runSteps(target, updating, vars);
    id = vars.id ?? "";
    if (!id)
      throw new Error(
        `${target.label}: couldn't find the new document's id in the reply`,
      );
    if (!updating && images.length > 0 && target.update.length > 0) {
      const withImages = await uploadImages(doc, target, id, contents, images);
      if (withImages !== contents) {
        const update = { file: await writePublishTemp(basename(file), withImages), title, content: withImages, id };
        await runSteps(target, true, update);
      }
    }
    // Keep the link from the first publish (update replies may be less friendly),
    // else use one from the reply, else build it from the template.
    url =
      previous?.url ||
      vars.url ||
      (target.urlTemplate ? String(fill(target.urlTemplate, vars)) : "");
    if (!url)
      throw new Error(
        `${target.label}: no link in the reply and no "urlTemplate" set`,
      );
  }
  return { id, url };
}

/**
 * Upload a document's local images to its page with the target's `images`
 * command and point them at the uploads. Images are read where the document
 * lives (over ssh for a remote one). One that can't be read or uploaded keeps
 * its local path, and the publish says so.
 */
async function uploadImages(
  doc: Doc,
  target: PublishTarget,
  pageId: string,
  contents: string,
  images: string[],
): Promise<string> {
  if (images.length === 0) return contents;
  const where = doc.remote?.path ?? doc.path;
  const baseDir = where ? where.slice(0, where.lastIndexOf("/")) : null;
  const urls = new Map<string, string>();
  const failed: string[] = [];
  for (const src of images) {
    const path = resolveLink(baseDir, src);
    if (!path) continue;
    const name = basename(path);
    try {
      const file = doc.remote
        ? await publishWriteTempBytes(name, await readRemoteBytes(doc.remote.host, path))
        : path;
      urls.set(src, await publishUploadImage(target.id, pageId, file, name));
    } catch (err) {
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0) imageWarnings.push(...failed);
  return rewriteImages(contents, urls);
}

/** Linked documents published at once (each mostly waits on the service). */
const LINKED_AT_ONCE = 4;

/** Run `fn` over `items`, at most `limit` at a time; resolves when all are done. */
async function inParallel<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Images that couldn't be uploaded during the current publish. */
let imageWarnings: string[] = [];

/**
 * Publish (or republish) a document to a target and copy the link. With
 * `linked`, the local markdown files it links to are published first (updated
 * in place if they were before, so their links stay put), and the published
 * copy links to them instead of to the local paths. One hop only.
 */
export async function publishDoc(
  doc: Doc,
  target: PublishTarget,
  options: {
    asNew?: boolean;
    linked?: boolean;
    account?: string;
    /** Password-protected pages: also used for the linked documents. */
    password?: string;
    /** GitHub Pages: publish without a password (linked documents too). */
    open?: boolean;
    /** GitHub Pages: list this document (not its linked ones) on the index page. */
    listed?: boolean;
    /** GitHub documents: keep this document (not its linked ones) in sync. */
    sync?: boolean;
    onProgress?: (text: string) => void;
  } = {},
): Promise<PublishOutcome> {
  let markdown = liveMarkdown(doc);
  const skipped: string[] = [];
  imageWarnings = [];
  const batch = target.kind === "pages" ? new PagesBatch() : undefined;
  let linkedCount = 0;

  if (options.linked) {
    // Two links to one file through different paths publish it once.
    const entries = linkedDocs(doc);
    await inParallel(entries, LINKED_AT_ONCE, (entry) => resolveRealKey(entry.doc));
    const byReal = new Map<string, LinkedDoc>();
    for (const entry of entries) {
      const real = recordKey(entry.doc) ?? keyForDoc(entry.doc) ?? "";
      const seen = byReal.get(real);
      if (seen) seen.hrefs.push(...entry.hrefs);
      else byReal.set(real, entry);
    }
    const links = [...byReal.values()];
    const urls = new Map<string, string>();
    const failed: string[] = new Array(links.length);
    let finished = 0;
    if (links.length > 0) options.onProgress?.(`linked documents: 0 of ${links.length}`);
    // A few at a time: each is mostly waiting on the service.
    await inParallel(links, LINKED_AT_ONCE, async ({ doc: linked, hrefs }, i) => {
      try {
        // A linked document published before keeps its own protection and
        // password; only new ones take this publish's choices.
        const prior = publishedFor(linked)[target.id];
        const { url } = await publishText(
          linked,
          await readLinked(linked),
          target,
          false,
          {
            account: options.account,
            password: prior ? undefined : options.password,
            open: prior ? undefined : options.open,
          },
          batch,
        );
        for (const href of hrefs) urls.set(href, url);
        linkedCount++;
      } catch (err) {
        failed[i] = `${linked.title}: ${err instanceof Error ? err.message : String(err)}`;
      }
      options.onProgress?.(`linked documents: ${++finished} of ${links.length}`);
    });
    skipped.push(...failed.filter(Boolean));
    markdown = rewriteLinks(markdown, urls);
    options.onProgress?.(displayTitle(doc));
  } else {
    // Linked documents aren't republished, but links to the ones already
    // published here still point at their pages; only never-published ones
    // stay as file paths.
    await inParallel(linkedDocs(doc), LINKED_AT_ONCE, ({ doc: linked }) => resolveRealKey(linked));
    markdown = rewriteLinks(markdown, publishedLinks(doc, target.id));
  }

  const { account, open, listed, ...out } = await publishText(
    doc,
    markdown,
    target,
    !!options.asNew,
    {
      account: options.account,
      password: options.password,
      open: options.open,
      listed: options.listed,
      sync: options.sync,
    },
    batch,
  );
  // Images that didn't upload stay as local paths in the published copy.
  skipped.push(...imageWarnings.map((w) => `image ${w}`));
  const result: PublishOutcome = { ...out, linked: linkedCount, skipped };

  if (batch) {
    // The page goes up either way; an index that couldn't be updated is
    // reported. Checked every time (not just when this Mac listed it): the
    // page may have been listed from another Mac.
    const entry: IndexEntry = {
      id: out.id,
      title: firstH1(markdown) ?? out.title,
      url: out.url,
      locked: !open,
      at: Date.now(),
    };
    try {
      const indexUrl = await updateIndex(
        account,
        (entries) => (listed ? withEntry(entries, entry) : withoutEntry(entries, out.id)),
        batch,
      );
      if (listed) result.indexUrl = indexUrl;
    } catch (err) {
      result.indexError = err instanceof Error ? err.message : String(err);
    }
    options.onProgress?.("uploading");
    await batch.commit();
  }
  await copyToClipboard(out.url);
  return result;
}

/** How often published GitHub documents are checked for changes (ms). */
const GITHUB_SYNC_MS = 5 * 60 * 1000;

/** A document's links to files already published to `targetId`, mapped to their pages. */
function publishedLinks(doc: Doc, targetId: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const { doc: linked, hrefs } of linkedDocs(doc)) {
    const url = publishedFor(linked)[targetId]?.url;
    if (url) for (const href of hrefs) urls.set(href, url);
  }
  return urls;
}

let syncing = false;

/**
 * Republish GitHub documents marked "keep in sync" whose file changed on
 * GitHub since their last publish. Linked documents aren't republished; links
 * to ones already published to the same target point at their pages.
 */
export async function syncGithubPublished(): Promise<void> {
  if (syncing) return;
  const due = Object.entries(loadRecords()).filter(
    ([key, byTarget]) => splitGithubSpec(key) && Object.values(byTarget).some((r) => r.sync),
  );
  if (due.length === 0) return;
  syncing = true;
  try {
    const targets = await publishTargets();
    for (const [key, byTarget] of due) {
      const remote = splitGithubSpec(key)!;
      for (const [targetId, rec] of Object.entries(byTarget)) {
        if (!rec.sync) continue;
        const errorKey = publishErrorKey(key, targetId);
        try {
          const target = targets.find((t) => t.id === targetId);
          if (!target) throw new Error(`The publish target "${targetId}" is no longer in publish.json`);
          const sha = await remoteStat(remote.host, remote.path);
          if (sha !== rec.sha) {
            const content = await readRemoteFile(remote.host, remote.path);
            const doc: Doc = { id: "", path: null, remote, title: basename(remote.path), content, saved: content };
            await publishText(doc, rewriteLinks(content, publishedLinks(doc, targetId)), target, false, { sha });
          }
          useStore.getState().setPublishError(errorKey, null);
        } catch (err) {
          useStore.getState().setPublishError(errorKey, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } finally {
    syncing = false;
  }
}

export function publishErrorKey(docKey: string, targetId: string): string {
  return `${docKey}\n${targetId}`;
}

/** Sync now and every few minutes while the app runs. */
export function initGithubSync(): void {
  void syncGithubPublished();
  setInterval(() => void syncGithubPublished(), GITHUB_SYNC_MS);
}
