import type { IncomingMessage, ServerResponse } from "node:http";
import { enrichSnippets, fetchText, getIndexBoard, getMarketNews, getQuotes, getStockNews, searchSymbols, type StockQuery } from "../src/feeds";
import { getStockDetail } from "../src/naverStock";
import { buildReviewBundle } from "../src/review";
import { translateNews } from "../src/translate";

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
    json(res, { items: await translateNews(await enrichSnippets(items)), pulls, fetchedAt: Date.now() });
    return;
  }
  if (path === "/api/stock-news") {
    const stocks = readStocks(url);
    const items = stocks.length ? await getStockNews(stocks) : [];
    json(res, { items: await translateNews(await enrichSnippets(items)), fetchedAt: Date.now() });
    return;
  }
  if (path === "/api/quotes") {
    const symbols = (url.searchParams.get("s") ?? "").split(",").filter(Boolean);
    json(res, { quotes: await getQuotes(symbols) });
    return;
  }
  if (path === "/api/indices") {
    json(res, { indices: await getIndexBoard() });
    return;
  }
  if (path === "/api/search") {
    json(res, { hits: await searchSymbols(url.searchParams.get("q") ?? "") });
    return;
  }
  if (path === "/api/review") {
    json(res, await buildReviewBundle());
    return;
  }
  if (path === "/api/stock-detail") {
    const id = url.searchParams.get("id") ?? "";
    const yahoo = url.searchParams.get("yahoo") ?? "";
    const market = url.searchParams.get("market");
    const name = url.searchParams.get("name") ?? id;
    if (!id || !yahoo || (market !== "kr" && market !== "us")) {
      json(res, { detail: null });
      return;
    }
    const detail = await getStockDetail(
      { id, yahoo, name, nameEn: name, aliases: [], market, popular: false },
      fetchText,
    );
    json(res, { detail });
    return;
  }
  json(res, { error: "not found" }, 404);
}
