export const SERVER_HTTP = import.meta.env.VITE_SERVER_HTTP || "http://localhost:8787";
export const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8787/ws";

export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_HTTP}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export type SheetPayload = {
  ok: boolean;
  columns: string[];
  rows: Record<string, any>[];
  error?: string;
};

export type Prize = Record<string, any> & {
  prize_id?: string;
  prize_name?: string;
  prize_image_url?: string;

  id?: string;
  name?: string;
  image?: string;

  qty?: any;
  active?: any;
  priority?: any;
};

export type Winner = {
  participant_id: string;
  name: string;
  team?: string;
  department?: string;
  raw?: Record<string, any>;
};

export type RealtimeUI = {
  showPrizePreview?: boolean;
  selectedPrizeIndex?: number;
  previewHint?: string;
};

export type RealtimeState = {
  mode: "exclude" | "repeat";
  prize: Prize | null;
  spinning: boolean;
  countdown: number;
  lastWinner: Winner | null;
  ui?: RealtimeUI;
};

export function safeStr(v: any) {
  return String(v ?? "").trim();
}

/**
 * ✅ Resolve image url (Presenter uses this)
 * - absolute http(s) => ok
 * - starts with "/" => ok
 * - else => "/xxx.jpg"
 */
export function resolvePrizeImage(p: Prize | null | undefined): string {
  if (!p) return "";
  const raw = safeStr(p.prize_image_url || p.image);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return raw;
  return `/${raw}`;
}