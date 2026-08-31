import { mergeNews, mergePulls, mergeQuotes, pruneNews } from "./archive";
import { fetchText, getIndexBoard, getQuotes, searchSymbols } from "./feeds";
import { detailFromQuote, getStockDetail } from "./naverStock";
import { mergeIndices } from "./indices";
import rawReview from "./review.json";
import rawSnapshot from "./snapshot.json";
import type { IndexQuote, NewsItem, Quote, ReviewBundle, SearchHit, SourcePull, Stock, StockDetail } from "./types";

const snapshot = rawSnapshot as unknown as {
  market: NewsItem[];
  stocks: NewsItem[];
  quotes: Quote[];
  indices?: IndexQuote[];
  stockDetails?: Record<string, StockDetail>;
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

export function bundledIndices(): IndexQuote[] {
  return snapshot.indices ?? [];
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

export async function fetchQuotes(stocks: Stock[], previous: Quote[] = [], live = true): Promise<Quote[]> {
  if (stocks.length === 0) return [];
  const wanted = new Set(stocks.map((s) => s.yahoo));
  const take = (rows: Quote[]) => rows.filter((q) => wanted.has(q.symbol));
  let rows = take(previous);
  if (localApi) {
    const s = stocks.map((x) => x.yahoo).join(",");
    const data = await getJson<{ quotes: Quote[] }>(`/api/quotes?s=${encodeURIComponent(s)}`);
    return mergeQuotes(rows, take(data.quotes ?? []));
  }
  let fromFile: Quote[] = [];
  try {
    const data = await getJson<{ quotes: Quote[] }>(dataUrl("quotes.json"));
    fromFile = take(data.quotes ?? []);
    rows = mergeQuotes(rows, fromFile);
  } catch {
    fromFile = take(bundledQuotes());
    rows = mergeQuotes(rows, fromFile);
  }
  if (!live) return rows.filter((q) => q.price > 0);
  const have = new Set(rows.filter((q) => q.price > 0).map((q) => q.symbol));
  const missing = stocks.map((s) => s.yahoo).filter((symbol) => !have.has(symbol));
  if (missing.length === 0) return rows.filter((q) => q.price > 0);
  try {
    return mergeQuotes(rows, take(await getQuotes(missing))).filter((q) => q.price > 0);
  } catch {
    return rows.filter((q) => q.price > 0);
  }
}

export async function fetchIndices(previous: IndexQuote[] = [], live = true): Promise<IndexQuote[]> {
  const seed = previous.length ? previous : bundledIndices();
  if (localApi) {
    const data = await getJson<{ indices: IndexQuote[] }>("/api/indices");
    return mergeIndices(seed, data.indices ?? []);
  }
  let rows = mergeIndices([], seed);
  try {
    const data = await getJson<{ indices?: IndexQuote[] }>(dataUrl("indices.json"));
    rows = mergeIndices(rows, data.indices ?? []);
  } catch {
    rows = mergeIndices(rows, bundledIndices());
  }
  if (!live) return rows;
  try {
    return mergeIndices(rows, await getIndexBoard());
  } catch {
    return rows;
  }
}

export function bundledStockDetail(id: string): StockDetail | undefined {
  return snapshot.stockDetails?.[id];
}

export async function fetchQuoteQuick(stock: Stock): Promise<Quote | null> {
  try {
    const rows = await getQuotes([stock.yahoo]);
    const q = rows[0];
    return q && q.price > 0 ? q : null;
  } catch {
    return null;
  }
}

export async function fetchStockDetail(stock: Stock): Promise<StockDetail | null> {
  if (localApi) {
    const q = new URLSearchParams({
      id: stock.id,
      yahoo: stock.yahoo,
      market: stock.market,
      name: stock.name,
    });
    const data = await getJson<{ detail: StockDetail | null }>(`/api/stock-detail?${q}`);
    return data.detail ?? null;
  }
  const cached = bundledStockDetail(stock.id);
  if (stock.market === "us") {
    const yahooQ = await fetchQuoteQuick(stock);
    if (yahooQ) return detailFromQuote(stock, yahooQ);
    const live = await getStockDetail(stock, fetchText).catch(() => null);
    if (live) return live;
  } else {
    const live = await getStockDetail(stock, fetchText).catch(() => null);
    if (live) return live;
  }
  if (cached) return cached;
  try {
    const data = await getJson<{ details?: Record<string, StockDetail> }>(dataUrl("details.json"));
    return data.details?.[stock.id] ?? null;
  } catch {
    return null;
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
