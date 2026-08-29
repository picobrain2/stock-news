import { mkdir, writeFile } from "node:fs/promises";
import { defaultWatchlist, popularStocks } from "../src/catalog";
import { getMarketNews, getQuotes, getStockNews } from "../src/feeds";

const outDir = new URL("../public/data/", import.meta.url);

async function main(): Promise<void> {
  const stocks = [...new Map(
    [...defaultWatchlist(), ...popularStocks()].map((s) => [s.id, s]),
  ).values()];
  console.log(`prefetch ${stocks.length} stocks`);
  const [market, stockNews, quotes] = await Promise.all([
    getMarketNews(),
    getStockNews(stocks, { light: true }),
    getQuotes(stocks.map((s) => s.yahoo)),
  ]);
  await mkdir(outDir, { recursive: true });
  const fetchedAt = Date.now();
  await writeFile(new URL("market.json", outDir), JSON.stringify({ items: market, fetchedAt }));
  await writeFile(new URL("stocks.json", outDir), JSON.stringify({ items: stockNews, fetchedAt }));
  await writeFile(new URL("quotes.json", outDir), JSON.stringify({ quotes, fetchedAt }));
  console.log(`wrote market=${market.length} stocks=${stockNews.length} quotes=${quotes.length}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
