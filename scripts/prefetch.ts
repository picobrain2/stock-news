import { mkdir, writeFile } from "node:fs/promises";
import { mergeNews, mergeQuotes, pruneNews } from "../src/archive";
import { defaultWatchlist, popularStocks } from "../src/catalog";
import { getMarketNews, getQuotes, getStockNews } from "../src/feeds";
import type { NewsItem, Quote } from "../src/types";

const outDir = new URL("../public/data/", import.meta.url);
const snapshotFile = new URL("../src/snapshot.json", import.meta.url);
const LIVE = "https://picobrain2.github.io/stock-news/data/";

async function readLiveNews(file: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(`${LIVE}${file}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: NewsItem[] };
    return pruneNews(data.items ?? []);
  } catch {
    return [];
  }
}

async function readLiveQuotes(): Promise<Quote[]> {
  try {
    const res = await fetch(`${LIVE}quotes.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { quotes?: Quote[] };
    return data.quotes ?? [];
  } catch {
    return [];
  }
}

async function writeJson(url: URL, body: unknown): Promise<void> {
  await writeFile(url, JSON.stringify(body));
}

async function main(): Promise<void> {
  const stocks = [...new Map(
    [...defaultWatchlist(), ...popularStocks()].map((s) => [s.id, s]),
  ).values()];
  console.log(`prefetch ${stocks.length} stocks`);
  const [prevMarket, prevStocks, prevQuotes, market, stockNews, quotes] = await Promise.all([
    readLiveNews("market.json"),
    readLiveNews("stocks.json"),
    readLiveQuotes(),
    getMarketNews(),
    getStockNews(stocks, { light: true }),
    getQuotes(stocks.map((s) => s.yahoo)),
  ]);
  const fetchedAt = Date.now();
  const marketMerged = mergeNews(prevMarket, market);
  const stocksMerged = mergeNews(prevStocks, stockNews);
  const quotesMerged = mergeQuotes(prevQuotes, quotes);
  await mkdir(outDir, { recursive: true });
  const marketBody = { items: marketMerged, fetchedAt };
  const stocksBody = { items: stocksMerged, fetchedAt };
  const quotesBody = { quotes: quotesMerged, fetchedAt };
  await writeJson(new URL("market.json", outDir), marketBody);
  await writeJson(new URL("stocks.json", outDir), stocksBody);
  await writeJson(new URL("quotes.json", outDir), quotesBody);
  await writeJson(snapshotFile, {
    market: marketMerged,
    stocks: stocksMerged,
    quotes: quotesMerged,
    fetchedAt,
  });
  console.log(`prev market=${prevMarket.length} + new=${market.length} -> ${marketMerged.length}`);
  console.log(`prev stocks=${prevStocks.length} + new=${stockNews.length} -> ${stocksMerged.length}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
