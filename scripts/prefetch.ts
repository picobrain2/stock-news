import { mkdir, writeFile } from "node:fs/promises";
import { mergeNews, mergePulls, mergeQuotes, pruneNews } from "../src/archive";
import { defaultWatchlist, popularStocks } from "../src/catalog";
import { enrichSnippets, fetchText, getIndexBoard, getMarketNews, getQuotes, getStockNews } from "../src/feeds";
import { mergeIndices } from "../src/indices";
import { getStockDetail } from "../src/naverStock";
import { buildReviewBundle } from "../src/review";
import { translateNews } from "../src/translate";
import type { IndexQuote, NewsItem, Quote, SourcePull, Stock, StockDetail } from "../src/types";

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

async function readLiveIndices(): Promise<IndexQuote[]> {
  try {
    const res = await fetch(`${LIVE}indices.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { indices?: IndexQuote[] };
    return data.indices ?? [];
  } catch {
    return [];
  }
}

async function readLivePulls(): Promise<SourcePull[]> {
  try {
    const res = await fetch(`${LIVE}market.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { pulls?: SourcePull[] };
    return data.pulls ?? [];
  } catch {
    return [];
  }
}

async function writeJson(url: URL, body: unknown): Promise<void> {
  await writeFile(url, JSON.stringify(body));
}

async function prefetchStockDetails(stockList: Stock[]): Promise<Record<string, StockDetail>> {
  const details: Record<string, StockDetail> = {};
  await Promise.all(stockList.map(async (stock) => {
    try {
      const row = await getStockDetail(stock, fetchText);
      if (row) details[stock.id] = row;
    } catch (err) {
      console.error(`detail failed ${stock.id}`, err);
    }
  }));
  return details;
}

async function main(): Promise<void> {
  const stocks = [...new Map(
    [...defaultWatchlist(), ...popularStocks()].map((s) => [s.id, s]),
  ).values()];
  console.log(`prefetch ${stocks.length} stocks`);
  const [prevMarket, prevStocks, prevQuotes, prevPulls, prevIndices, fresh, stockNews, quotes, indices] = await Promise.all([
    readLiveNews("market.json"),
    readLiveNews("stocks.json"),
    readLiveQuotes(),
    readLivePulls(),
    readLiveIndices(),
    getMarketNews(),
    getStockNews(stocks, { light: true }),
    getQuotes(stocks.map((s) => s.yahoo)),
    getIndexBoard().catch((err: unknown) => {
      console.error("indices failed", err);
      return [] as IndexQuote[];
    }),
  ]);
  const fetchedAt = Date.now();
  const [marketMerged, stocksMerged] = await Promise.all([
    translateNews(await enrichSnippets(mergeNews(prevMarket, fresh.items)), 24),
    translateNews(await enrichSnippets(mergeNews(prevStocks, stockNews)), 24),
  ]);
  const quotesMerged = mergeQuotes(prevQuotes, quotes);
  const indicesMerged = mergeIndices(prevIndices, indices);
  const pullsMerged = mergePulls(prevPulls, fresh.pulls);
  let reviewBundle = { week: null, month: null, year: null, fetchedAt };
  try {
    reviewBundle = await buildReviewBundle();
  } catch (err) {
    console.error("review failed", err);
  }
  const stockDetails = await prefetchStockDetails(stocks);
  await mkdir(outDir, { recursive: true });
  const marketBody = { items: marketMerged, pulls: pullsMerged, fetchedAt };
  const stocksBody = { items: stocksMerged, fetchedAt };
  const quotesBody = { quotes: quotesMerged, fetchedAt };
  const indicesBody = { indices: indicesMerged, fetchedAt };
  await writeJson(new URL("market.json", outDir), marketBody);
  await writeJson(new URL("stocks.json", outDir), stocksBody);
  await writeJson(new URL("quotes.json", outDir), quotesBody);
  await writeJson(new URL("indices.json", outDir), indicesBody);
  await writeJson(new URL("details.json", outDir), { details: stockDetails, fetchedAt });
  await writeJson(new URL("review.json", outDir), reviewBundle);
  await writeJson(new URL("../src/review.json", import.meta.url), reviewBundle);
  await writeJson(snapshotFile, {
    market: marketMerged,
    stocks: stocksMerged,
    quotes: quotesMerged,
    indices: indicesMerged,
    stockDetails,
    pulls: pullsMerged,
    fetchedAt,
  });
  console.log(`prev market=${prevMarket.length} + new=${fresh.items.length} -> ${marketMerged.length}`);
  console.log(`prev stocks=${prevStocks.length} + new=${stockNews.length} -> ${stocksMerged.length}`);
  console.log(`quotes ${quotesMerged.length} symbols, details ${Object.keys(stockDetails).length}`);
  console.log(`indices ${indicesMerged.map((i) => i.name).join(", ") || "none"}`);
  console.log("pulls", pullsMerged.map((p) => `${p.source}:${p.ok ? p.count : "fail"}`).join(", "));
  console.log(`review week=${reviewBundle.week?.timeline.length ?? 0} month=${reviewBundle.month?.timeline.length ?? 0} year=${reviewBundle.year?.timeline.length ?? 0}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
