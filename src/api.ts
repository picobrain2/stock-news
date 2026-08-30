import { mergeNews, mergePulls, mergeQuotes, pruneNews } from "./archive";
import { searchSymbols } from "./feeds";
import rawReview from "./review.json";
import rawSnapshot from "./snapshot.json";
import type { NewsItem, Quote, ReviewBundle, SearchHit, SourcePull, Stock } from "./types";

const snapshot = rawSnapshot as unknown as {
  market: NewsItem[];
  stocks: NewsItem[];
  quotes: Quote[];
  pulls?: SourcePull[];
  fetchedAt: number;
};

const reviewSnap = rawReview as unknown as ReviewBundle;

const localApi = import.meta.env.DEV;

export let bundleFetchedAt = 0;
export let lastPulls: SourcePull[] = snapshot.pulls ?? [];

function dataUrl(file: string): string {
  return `${new URL(`../data/${file}`, import.meta.url).href}?t=${Math.floor(Date.now() / 15_000)}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.json() as Promise<T>;
}

export function bundledMarket(): NewsItem[] {
  return pruneNews(snapshot.market ?? []);
}

export function bundledStocks(): NewsItem[] {
  return pruneNews(snapshot.stocks ?? []);
}

export function bundledQuotes(): Quote[] {
  return snapshot.quotes ?? [];
}

export function bundledPulls(): SourcePull[] {
  return snapshot.pulls ?? [];
}

export function bundledReview(): ReviewBundle {
  return {
    week: reviewSnap.week ?? null,
    month: reviewSnap.month ?? null,
    year: reviewSnap.year ?? null,
    fetchedAt: reviewSnap.fetchedAt ?? 0,
  };
}

export async function fetchReview(): Promise<ReviewBundle> {
  if (localApi) {
    return getJson<ReviewBundle>("/api/review");
  }
  try {
    return await getJson<ReviewBundle>(dataUrl("review.json"));
  } catch {
    return bundledReview();
  }
}

export async function fetchMarket(previous: NewsItem[] = []): Promise<NewsItem[]> {
  if (localApi) {
    const data = await getJson<{ items: NewsItem[]; pulls?: SourcePull[] }>("/api/market");
    lastPulls = mergePulls(lastPulls, data.pulls ?? []);
    return mergeNews(previous, data.items ?? []);
  }
  try {
    const data = await getJson<{ items: NewsItem[]; pulls?: SourcePull[]; fetchedAt?: number }>(dataUrl("market.json"));
    bundleFetchedAt = data.fetchedAt ?? Date.now();
    lastPulls = mergePulls(lastPulls, data.pulls ?? []);
    return mergeNews(previous, data.items ?? []);
  } catch {
    bundleFetchedAt = snapshot.fetchedAt || Date.now();
    lastPulls = mergePulls(lastPulls, bundledPulls());
    return mergeNews(previous, bundledMarket());
  }
}

export async function fetchStockNews(stocks: Stock[], previous: NewsItem[] = []): Promise<NewsItem[]> {
  if (stocks.length === 0) return [];
  const wanted = new Set(stocks.map((s) => s.id));
  const pick = (items: NewsItem[]) => items.filter((item) => item.stockIds.some((id) => wanted.has(id)));
  if (localApi) {
    const packed = stocks
      .map((s) => [s.id, s.yahoo, s.name, s.nameEn, s.market, s.aliases.join(",")].join("|"))
      .join(";");
    const data = await getJson<{ items: NewsItem[] }>(`/api/stock-news?stocks=${encodeURIComponent(packed)}`);
    return mergeNews(previous, pick(data.items ?? []));
  }
  try {
    const data = await getJson<{ items: NewsItem[]; fetchedAt?: number }>(dataUrl("stocks.json"));
    bundleFetchedAt = data.fetchedAt ?? bundleFetchedAt;
    return mergeNews(previous, pick(data.items ?? []));
  } catch {
    return mergeNews(previous, pick(bundledStocks()));
  }
}

export async function fetchQuotes(stocks: Stock[], previous: Quote[] = []): Promise<Quote[]> {
  if (stocks.length === 0) return [];
  const wanted = new Set(stocks.map((s) => s.yahoo));
  const pick = (rows: Quote[]) => rows.filter((q) => wanted.has(q.symbol));
  if (localApi) {
    const s = stocks.map((x) => x.yahoo).join(",");
    const data = await getJson<{ quotes: Quote[] }>(`/api/quotes?s=${encodeURIComponent(s)}`);
    return mergeQuotes(previous, pick(data.quotes ?? []));
  }
  try {
    const data = await getJson<{ quotes: Quote[] }>(dataUrl("quotes.json"));
    return mergeQuotes(previous, pick(data.quotes ?? []));
  } catch {
    return mergeQuotes(previous, pick(bundledQuotes()));
  }
}

export async function searchRemote(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (localApi) {
    const data = await getJson<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
    return data.hits ?? [];
  }
  try {
    return await searchSymbols(q);
  } catch {
    return [];
  }
}
