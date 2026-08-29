import { getMarketNews, getQuotes, getStockNews, searchSymbols } from "./feeds";
import type { NewsItem, Quote, SearchHit, Stock } from "./types";

const localApi = import.meta.env.DEV;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.json() as Promise<T>;
}

export async function fetchMarket(): Promise<NewsItem[]> {
  if (!localApi) return getMarketNews();
  const data = await getJson<{ items: NewsItem[] }>("/api/market");
  return data.items ?? [];
}

export async function fetchStockNews(stocks: Stock[]): Promise<NewsItem[]> {
  if (stocks.length === 0) return [];
  if (!localApi) return getStockNews(stocks);
  const packed = stocks
    .map((s) => [s.id, s.yahoo, s.name, s.nameEn, s.market, s.aliases.join(",")].join("|"))
    .join(";");
  const data = await getJson<{ items: NewsItem[] }>(`/api/stock-news?stocks=${encodeURIComponent(packed)}`);
  return data.items ?? [];
}

export async function fetchQuotes(stocks: Stock[]): Promise<Quote[]> {
  if (stocks.length === 0) return [];
  if (!localApi) return getQuotes(stocks.map((x) => x.yahoo));
  const s = stocks.map((x) => x.yahoo).join(",");
  const data = await getJson<{ quotes: Quote[] }>(`/api/quotes?s=${encodeURIComponent(s)}`);
  return data.quotes ?? [];
}

export async function searchRemote(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (!localApi) return searchSymbols(q);
  const data = await getJson<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
  return data.hits ?? [];
}
