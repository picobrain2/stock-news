import { mkdir, writeFile } from "node:fs/promises";
import { mergeNews, mergePulls, pruneNews } from "../src/archive";
import { defaultWatchlist, popularStocks } from "../src/catalog";
import { enrichSnippets, getMarketNews, getStockNews } from "../src/feeds";
import { buildReviewBundle } from "../src/review";
import { translateNews } from "../src/translate";
import type { NewsItem, SourcePull } from "../src/types";

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

async function main(): Promise<void> {
  const stocks = [...new Map(
    [...defaultWatchlist(), ...popularStocks()].map((s) => [s.id, s]),
  ).values()];
  console.log(`prefetch news/review for ${stocks.length} catalog stocks (quotes/indices are live-only)`);

  const [prevMarket, prevStocks, prevPulls, fresh, stockNews] = await Promise.all([
    readLiveNews("market.json"),
    readLiveNews("stocks.json"),
    readLivePulls(),
    getMarketNews(),
    getStockNews(stocks, { light: true }),
  ]);
  const fetchedAt = Date.now();
  const [marketMerged, stocksMerged] = await Promise.all([
    translateNews(await enrichSnippets(mergeNews(prevMarket, fresh.items)), 24),
    translateNews(await enrichSnippets(mergeNews(prevStocks, stockNews)), 24),
  ]);
  const pullsMerged = mergePulls(prevPulls, fresh.pulls);

  let reviewBundle = { day: null, week: null, month: null, year: null, fetchedAt };
  try {
    reviewBundle = await buildReviewBundle();
  } catch (err) {
    console.error("review failed", err);
  }

  await mkdir(outDir, { recursive: true });
  await writeJson(new URL("market.json", outDir), { items: marketMerged, pulls: pullsMerged, fetchedAt });
  await writeJson(new URL("stocks.json", outDir), { items: stocksMerged, fetchedAt });
  // Keep empty placeholders so old clients don't 404; live poll fills the UI.
  await writeJson(new URL("quotes.json", outDir), { quotes: [], fetchedAt });
  await writeJson(new URL("indices.json", outDir), { indices: [], fetchedAt });
  await writeJson(new URL("details.json", outDir), { details: {}, fetchedAt });
  await writeJson(new URL("review.json", outDir), reviewBundle);
  await writeJson(new URL("../src/review.json", import.meta.url), reviewBundle);
  await writeJson(snapshotFile, {
    market: marketMerged,
    stocks: stocksMerged,
    quotes: [],
    indices: [],
    stockDetails: {},
    pulls: pullsMerged,
    fetchedAt,
  });

  console.log(`prev market=${prevMarket.length} + new=${fresh.items.length} -> ${marketMerged.length}`);
  console.log(`prev stocks=${prevStocks.length} + new=${stockNews.length} -> ${stocksMerged.length}`);
  console.log("pulls", pullsMerged.map((p) => `${p.source}:${p.ok ? p.count : "fail"}`).join(", "));
  console.log(`review day=${reviewBundle.day?.timeline.length ?? 0} week=${reviewBundle.week?.timeline.length ?? 0} month=${reviewBundle.month?.timeline.length ?? 0} year=${reviewBundle.year?.timeline.length ?? 0}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
