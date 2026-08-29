import type { IncomingMessage, ServerResponse } from "node:http";
import { getMarketNews, getQuotes, getStockNews, searchSymbols, type StockQuery } from "../src/feeds";

function readStocks(url: URL): StockQuery[] {
  const raw = url.searchParams.get("stocks") ?? "";
  if (!raw) return [];
  return raw.split(";").flatMap((part) => {
    const [id, yahoo, name, nameEn, market, aliases] = part.split("|");
    if (!id || !yahoo) return [];
    return [{
      id,
      yahoo,
      name: name || id,
      nameEn: nameEn || name || id,
      aliases: aliases ? aliases.split(",") : [],
      market: market === "kr" ? "kr" as const : "us" as const,
    }];
  }).slice(0, 16);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/market") {
    const { items, pulls } = await getMarketNews();
    json(res, { items, pulls, fetchedAt: Date.now() });
    return;
  }
  if (path === "/api/stock-news") {
    const stocks = readStocks(url);
    json(res, { items: stocks.length ? await getStockNews(stocks) : [], fetchedAt: Date.now() });
    return;
  }
  if (path === "/api/quotes") {
    const symbols = (url.searchParams.get("s") ?? "").split(",").filter(Boolean);
    json(res, { quotes: await getQuotes(symbols) });
    return;
  }
  if (path === "/api/search") {
    json(res, { hits: await searchSymbols(url.searchParams.get("q") ?? "") });
    return;
  }
  json(res, { error: "not found" }, 404);
}
