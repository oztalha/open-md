import { setRecentFiles } from "./ipc";

/** An entry in the File → Open Recent menu. */
export interface RecentEntry {
  /** Open spec: a local path or an mdviewer:// URL. */
  spec: string;
  label: string;
  /** When it was last opened or saved (ms); missing on entries from older versions. */
  at?: number;
}

const STORAGE_KEY = "recentFiles";
const PINS_KEY = "pinnedFiles";
/** Sidebar keeps the last 500 (it scrolls); the native menu shows the newest 20. */
const MAX = 500;
const MENU_MAX = 20;

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

function loadPins(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

let entries = load();
/** Pinned files: kept above Recent, in their own order, never evicted. */
let pins = loadPins();
const listeners = new Set<() => void>();

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  void setRecentFiles([...pins, ...entries].slice(0, MENU_MAX)).catch(() => {});
  listeners.forEach((fn) => fn());
}

/** Current recents, most recent first. */
export function getRecents(): RecentEntry[] {
  return entries;
}

/** Re-render on changes (the sidebar's Recent section). */
export function subscribeRecents(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function removeRecent(spec: string): void {
  entries = entries.filter((e) => e.spec !== spec);
  pins = pins.filter((e) => e.spec !== spec);
  persist();
}

/** Pinned files, in the user's order. */
export function getPins(): RecentEntry[] {
  return pins;
}

export function isPinned(spec: string): boolean {
  return pins.some((e) => e.spec === spec);
}

/** Pin a file (moves it out of Recent), or unpin it (back into Recent). */
export function togglePin(spec: string, label: string): void {
  if (isPinned(spec)) {
    const at = pins.find((e) => e.spec === spec)?.at;
    pins = pins.filter((e) => e.spec !== spec);
    entries = [{ spec, label, at }, ...entries.filter((e) => e.spec !== spec)].slice(0, MAX);
  } else {
    const at = entries.find((e) => e.spec === spec)?.at;
    pins = [...pins, { spec, label, at }];
    entries = entries.filter((e) => e.spec !== spec);
  }
  persist();
}

/**
 * Move a recent file next to another (drag-to-reorder). Indices are in the
 * sidebar's filtered list (open files hidden), so we place by neighbour spec.
 */
export function reorderRecent(spec: string, beforeSpec: string | null): void {
  const item = entries.find((e) => e.spec === spec);
  if (!item || spec === beforeSpec) return;
  const next = entries.filter((e) => e.spec !== spec);
  const at = beforeSpec ? next.findIndex((e) => e.spec === beforeSpec) : -1;
  next.splice(at === -1 ? next.length : at, 0, item);
  entries = next;
  persist();
}

/** Move a pinned file to a new index (drag-to-reorder). */
export function reorderPin(spec: string, toIndex: number): void {
  const from = pins.findIndex((e) => e.spec === spec);
  if (from === -1) return;
  const clamped = Math.max(0, Math.min(pins.length - 1, toIndex));
  if (from === clamped) return;
  const next = pins.filter((e) => e.spec !== spec);
  next.splice(clamped, 0, pins[from]);
  pins = next;
  persist();
}

/** Record a freshly opened/saved document; most recent first, de-duplicated. */
export function addRecent(spec: string, label: string): void {
  // A pinned file stays in Pinned; only its label refreshes.
  if (isPinned(spec)) {
    pins = pins.map((e) => (e.spec === spec ? { spec, label, at: Date.now() } : e));
    persist();
    return;
  }
  entries = [{ spec, label, at: Date.now() }, ...entries.filter((e) => e.spec !== spec)].slice(0, MAX);
  persist();
}

/** When a recent file was last opened, short: "14:05" today, "Yesterday", "Mon", "Nov 3", "Nov 3, 2025". */
export function recentWhen(at: number | undefined, now = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Clear Recent; pinned files stay. */
export function clearRecents(): void {
  entries = [];
  persist();
}

/** Push the persisted list into the native menu (after the menu is built). */
export function initRecents(): void {
  const menu = [...pins, ...entries].slice(0, MENU_MAX);
  if (menu.length) void setRecentFiles(menu).catch(() => {});
}
