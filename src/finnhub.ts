import { classifyTone, scoreImpact } from "./impact";
import type { NewsItem } from "./types";

const isBrowser = typeof window !== "undefined";

function apiKey(): string {
  if (isBrowser) return "";
  return (process.env.FINNHUB_API_KEY ?? "").trim();
}

export function finnhubEnabled(): boolean {
  return Boolean(apiKey());
}

function ymd(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type FinnhubArticle = {
  category?: string;
  datetime?: number;
  headline?: string;
  id?: number | string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
};

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function toItem(row: FinnhubArticle, stockIds: string[], region: "us" | "global"): NewsItem | null {
  const title = (row.headline ?? "").trim();
  const url = (row.url ?? "").trim();
  if (!title || !url) return null;
  const snippet = (row.summary ?? "").trim();
  const { score, tags } = scoreImpact(title, snippet);
  const source = (row.source ?? "Finnhub").trim() || "Finnhub";
  return {
    id: `fh-${row.id ?? hash(url)}`,
    title,
    url,
    source,
    publishedAt: (row.datetime ?? 0) * 1000 || 0,
    snippet,
    tags,
    region,
    stockIds,
    impact: score,
    tone: classifyTone(title, snippet, stockIds).tone,
  };
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const q = new URLSearchParams({ ...params, token: key });
  const url = `https://finnhub.io/api/v1/${path}?${q.toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`finnhub ${path} ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`finnhub ${path} failed`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** US market general headlines — Node/prefetch only. */
export async function finnhubMarketNews(): Promise<NewsItem[]> {
  const rows = await getJson<FinnhubArticle[]>("news", { category: "general" });
  if (!rows?.length) return [];
  const dayAgo = Date.now() - 86_400_000;
  return rows
    .map((row) => toItem(row, [], "us"))
    .filter((n): n is NewsItem => Boolean(n))
    .filter((n) => n.publishedAt <= 0 || n.publishedAt >= dayAgo)
    .slice(0, 40);
}

/** Company news for a US ticker — Node/prefetch only. */
export async function finnhubCompanyNews(symbol: string, days = 7): Promise<NewsItem[]> {
  const ticker = symbol.trim().toUpperCase().replace(/\.(KS|KQ)$/i, "");
  if (!ticker || /\d/.test(ticker) && ticker.length >= 6) return [];
  const to = Date.now();
  const from = to - days * 86_400_000;
  const rows = await getJson<FinnhubArticle[]>("company-news", {
    symbol: ticker,
    from: ymd(from),
    to: ymd(to),
  });
  if (!rows?.length) return [];
  return rows
    .map((row) => toItem(row, [ticker], "us"))
    .filter((n): n is NewsItem => Boolean(n))
    .slice(0, 20);
}
