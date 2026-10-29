/**
 * Search in Files (⇧⌘F): the matching rules, shared by open documents
 * (searched in memory) and the result list, so highlights agree with what
 * `grep` found on disk or over ssh.
 */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LineHit {
  line: number;
  text: string;
}

/** Most matching lines shown per file (grep stops there too). */
export const MAX_HITS_PER_FILE = 50;
const LINE_CHARS = 400;

/** The query as a global RegExp, or null when it's empty or not a valid regex. */
export function matcher(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Matching lines of a text (1-based line numbers). */
export function searchText(text: string, re: RegExp): LineHit[] {
  const hits: LineHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < MAX_HITS_PER_FILE; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].slice(0, LINE_CHARS) });
  }
  return hits;
}

/**
 * A line cut to fit, starting a little before its first match (the sidebar
 * is narrow, so the match must come early), as plain and matched parts for
 * highlighting.
 */
export function snippet(text: string, re: RegExp, width = 120, lead = 16): { text: string; match: boolean }[] {
  re.lastIndex = 0;
  const first = re.exec(text);
  let start = 0;
  if (first && first.index > lead) start = first.index - lead;
  let view = text.slice(start, start + width).replace(/\t/g, " ");
  if (start > 0) view = "…" + view.trimStart();
  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (const m of view.matchAll(re)) {
    if (!m[0]) break;
    if (m.index > last) parts.push({ text: view.slice(last, m.index), match: false });
    parts.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < view.length) parts.push({ text: view.slice(last), match: false });
  return parts.length ? parts : [{ text: view, match: false }];
}
