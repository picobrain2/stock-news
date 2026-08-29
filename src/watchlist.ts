import type { Stock } from "./types";
import { defaultWatchlist, findStock } from "./catalog";

const KEY = "sihwang.watchlist.v1";

export function loadWatchlist(): Stock[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultWatchlist();
    const parsed = JSON.parse(raw) as Stock[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultWatchlist();
    return parsed
      .filter((s) => s && typeof s.id === "string" && typeof s.yahoo === "string")
      .map((s) => findStock(s.id) ?? s)
      .slice(0, 16);
  } catch {
    return defaultWatchlist();
  }
}

export function saveWatchlist(stocks: Stock[]): void {
  localStorage.setItem(KEY, JSON.stringify(stocks.slice(0, 16)));
}
