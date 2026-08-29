import { searchSymbols } from "./feeds";
import type { NewsItem, Quote, SearchHit, Stock } from "./types";

const localApi = import.meta.env.DEV;

export let bundleFetchedAt = 0;

function dataUrl(file: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}data/${file}?t=${Math.floor(Date.now() / 30_000)}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.json() as Promise<T>;
}

export async function fetchMarket(): Promise<NewsItem[]> {
  if (localApi) {
    const data = await getJson<{ items: NewsItem[] }>("/api/market");
    return data.items ?? [];
  }
  const data = await getJson<{ items: NewsItem[]; fetchedAt?: number }>(dataUrl("market.json"));
  bundleFetchedAt = data.fetchedAt ?? Date.now();
  return data.items ?? [];
}

export async function fetchStockNews(stocks: Stock[]): Promise<NewsItem[]> {
  if (stocks.length === 0) return [];
  if (localApi) {
    const packed = stocks
      .map((s) => [s.id, s.yahoo, s.name, s.nameEn, s.market, s.aliases.join(",")].join("|"))
      .join(";");
    const data = await getJson<{ items: NewsItem[] }>(`/api/stock-news?stocks=${encodeURIComponent(packed)}`);
    return data.items ?? [];
  }
  const data = await getJson<{ items: NewsItem[]; fetchedAt?: number }>(dataUrl("stocks.json"));
  bundleFetchedAt = data.fetchedAt ?? bundleFetchedAt;
  const wanted = new Set(stocks.map((s) => s.id));
  return (data.items ?? []).filter((item) => item.stockIds.some((id) => wanted.has(id)));
}

export async function fetchQuotes(stocks: Stock[]): Promise<Quote[]> {
  if (stocks.length === 0) return [];
  if (localApi) {
    const s = stocks.map((x) => x.yahoo).join(",");
    const data = await getJson<{ quotes: Quote[] }>(`/api/quotes?s=${encodeURIComponent(s)}`);
    return data.quotes ?? [];
  }
  const data = await getJson<{ quotes: Quote[] }>(dataUrl("quotes.json"));
  const wanted = new Set(stocks.map((s) => s.yahoo));
  return (data.quotes ?? []).filter((q) => wanted.has(q.symbol));
}

export async function searchRemote(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (localApi) {
    const data = await getJson<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
    return data.hits ?? [];
  }
  return searchSymbols(q);
}
