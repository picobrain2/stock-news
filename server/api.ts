import type { IncomingMessage, ServerResponse } from "node:http";
import { classifyTone, inferRegion, isMarketRelevant, scoreImpact } from "../src/impact";
import type { NewsItem, Quote, SearchHit } from "../src/types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 90_000;

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data as T);
  return load().then((data) => {
    cache.set(key, { at: Date.now(), data });
    return data;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function fetchText(url: string, timeoutMs = 9000): Promise<string> {
  let lastError = "fetch failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: "application/rss+xml, application/xml, text/xml, application/json, */*",
        },
      });
      if (res.status === 429 || res.status === 409) {
        lastError = String(res.status);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (res.status >= 400 && res.status < 500) throw new Error(`${res.status} ${url}`);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/^4\d\d\s/.test(lastError)) throw err instanceof Error ? err : new Error(lastError);
      if (attempt < 2) await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

function decode(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  return m ? decode(m[1]) : "";
}

function firstUrl(block: string): string {
  const link = tagText(block, "link");
  if (link.startsWith("http")) return link;
  const guid = tagText(block, "guid");
  if (guid.startsWith("http")) return guid;
  const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  return href?.[1] ?? "";
}

function sourceOf(block: string, title: string, url: string): string {
  const src = tagText(block, "source");
  if (src) return src;
  const dash = title.match(/\s[-–—]\s([^-–—]{2,40})$/);
  if (dash) return dash[1].trim();
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

function stripSource(title: string, source: string): string {
  let t = title.replace(/\s[-–—−－]\s[^-–—−－]{2,40}$/, "").trim();
  if (source && t.endsWith(source)) t = t.slice(0, -source.length).trim();
  return t || title;
}

function parseRss(xml: string, fallbackSource: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const rawTitle = tagText(block, "title");
    const url = firstUrl(block);
    if (!rawTitle || !url) continue;
    const source = sourceOf(block, rawTitle, url) || fallbackSource;
    const title = stripSource(rawTitle, source);
    const snippet = tagText(block, "description") || tagText(block, "summary");
    const dateRaw =
      tagText(block, "pubDate") ||
      tagText(block, "published") ||
      tagText(block, "updated") ||
      tagText(block, "dc:date");
    const publishedAt = Date.parse(dateRaw) || Date.now();
    const { score, tags } = scoreImpact(title, snippet);
    items.push({
      id: hash(`${url}|${title}`),
      title,
      url,
      source,
      publishedAt,
      snippet: snippet.slice(0, 240),
      tags,
      region: inferRegion(title, source, url),
      stockIds: [],
      impact: score,
      tone: classifyTone(title, snippet).tone,
    });
  }
  return items;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function googleNews(query: string, locale: "kr" | "us"): string {
  const params = new URLSearchParams();
  params.set("q", query);
  if (locale === "kr") {
    params.set("hl", "ko");
    params.set("gl", "KR");
    params.set("ceid", "KR:ko");
  } else {
    params.set("hl", "en-US");
    params.set("gl", "US");
    params.set("ceid", "US:en");
  }
  return `https://news.google.com/rss/search?${params.toString()}`;
}

async function rss(url: string, source: string): Promise<NewsItem[]> {
  const xml = await fetchText(url);
  return parseRss(xml, source);
}

async function settled<T>(jobs: Promise<T>[]): Promise<T[]> {
  const rows = await Promise.allSettled(jobs);
  return rows.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function mergeNews(groups: NewsItem[][]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  const now = Date.now();
  for (const item of groups.flat()) {
    if (item.title.replace(/\s+/g, "").length < 8) continue;
    if (now - item.publishedAt > 8 * 86_400_000) continue;
    const key = normalizeTitle(item.title).slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}

const MARKET_FEEDS: { source: string; url: string; requireImpact: boolean }[] = [
  { source: "Google 뉴스", url: googleNews("when:1d (금리 OR 연준 OR FOMC OR 환율 OR 원달러 OR 유가 OR 관세 OR CPI)", "kr"), requireImpact: false },
  { source: "Google 뉴스", url: googleNews("when:1d (코스피 OR 나스닥 OR 증시 OR 반도체 OR 실적 OR 한국은행)", "kr"), requireImpact: false },
  { source: "Google News", url: googleNews('when:1d (Fed OR FOMC OR tariff OR CPI OR "stock market" OR Nasdaq OR earnings)', "us"), requireImpact: false },
  { source: "Google 뉴스", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtdHZHZ0pMVWlnQVAB?hl=ko&gl=KR&ceid=KR:ko", requireImpact: true },
  { source: "한국경제", url: "https://www.hankyung.com/feed/finance", requireImpact: true },
  { source: "연합뉴스", url: "https://www.yna.co.kr/rss/economy.xml", requireImpact: true },
  { source: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", requireImpact: true },
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml", requireImpact: true },
];

async function getMarketNews(): Promise<NewsItem[]> {
  return cached("market", CACHE_MS, async () => {
    const groups = await settled(
      MARKET_FEEDS.map(async (feed) => {
        const items = await rss(feed.url, feed.source);
        return feed.requireImpact
          ? items.filter((n) => isMarketRelevant(n.title, n.snippet, n.impact))
          : items;
      }),
    );
    return mergeNews(groups)
      .filter((n) => Date.now() - n.publishedAt < 4 * 86_400_000)
      .slice(0, 80);
  });
}

interface StockQuery {
  id: string;
  name: string;
  nameEn: string;
  yahoo: string;
  aliases: string[];
  market: "kr" | "us";
}

function googleQuery(stock: StockQuery, locale: "kr" | "us"): string {
  const names = [stock.name, stock.nameEn, ...stock.aliases].filter(Boolean);
  const quoted = [...new Set(names)].slice(0, 4).map((n) => `"${n}"`);
  const extra = locale === "kr" ? [stock.id] : [stock.yahoo, stock.id];
  return `when:7d (${[...quoted, ...extra].join(" OR ")})`;
}

function mentionsStock(item: NewsItem, stock: StockQuery): boolean {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  const needles = [stock.id, stock.name, stock.nameEn, stock.yahoo, ...stock.aliases]
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2);
  return needles.some((n) => text.includes(n));
}

function isGenericTitle(title: string, stocks: StockQuery[]): boolean {
  const compact = title.replace(/\s+/g, "").toLowerCase();
  if (compact.length < 8) return true;
  return stocks.some((s) => {
    const names = [s.name, s.nameEn, s.id, s.yahoo].map((n) => n.replace(/\s+/g, "").toLowerCase());
    return names.includes(compact);
  });
}

async function yahooTickerNews(symbol: string): Promise<NewsItem[]> {
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/i.test(symbol) || symbol.includes(".")) return [];
  try {
    const raw = await fetchText(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=12`,
    );
    const data = JSON.parse(raw) as {
      news?: {
        uuid?: string;
        title?: string;
        publisher?: string;
        link?: string;
        providerPublishTime?: number;
        relatedTickers?: string[];
      }[];
    };
    return (data.news ?? [])
      .filter((n) => (n.relatedTickers ?? []).some((t) => t.toUpperCase() === symbol.toUpperCase()))
      .map((n) => {
        const title = n.title ?? "";
        const snippet = "";
        const { score, tags } = scoreImpact(title, snippet);
        return {
          id: n.uuid ?? hash(n.link ?? title),
          title,
          url: n.link ?? "",
          source: n.publisher ?? "Yahoo Finance",
          publishedAt: (n.providerPublishTime ?? 0) * 1000 || Date.now(),
          snippet,
          tags,
          region: "us" as const,
          stockIds: [symbol.toUpperCase()],
          impact: score,
          tone: classifyTone(title, snippet, [symbol]).tone,
        };
      })
      .filter((n) => n.title && n.url);
  } catch {
    return [];
  }
}

async function getStockNews(stocks: StockQuery[]): Promise<NewsItem[]> {
  const key = `stocks:${stocks.map((s) => s.id).sort().join(",")}`;
  return cached(key, CACHE_MS, async () => {
    const jobs: Promise<NewsItem[]>[] = [];
    for (const stock of stocks) {
      jobs.push(
        rss(googleNews(googleQuery(stock, "kr"), "kr"), "Google 뉴스").then((items) =>
          items.map((n) => ({ ...n, stockIds: [stock.id] })),
        ),
      );
      jobs.push(
        rss(googleNews(googleQuery(stock, "us"), "us"), "Google News").then((items) =>
          items.map((n) => ({ ...n, stockIds: [stock.id] })),
        ),
      );
      if (stock.market === "us") jobs.push(yahooTickerNews(stock.yahoo));
    }
    const groups = await settled(jobs);
    const tagged: NewsItem[] = [];
    for (const item of groups.flat()) {
      const matched = stocks.filter((s) => item.stockIds.includes(s.id) || mentionsStock(item, s));
      if (matched.length === 0 && item.stockIds.length === 0) continue;
      if (isGenericTitle(item.title, stocks)) continue;
      const ids = [...new Set([...item.stockIds, ...matched.map((s) => s.id)])];
      const names = matched.flatMap((s) => [s.name, s.nameEn, s.id, ...s.aliases]).filter(Boolean);
      tagged.push({
        ...item,
        stockIds: ids,
        tone: classifyTone(item.title, item.snippet, names).tone,
      });
    }
    return mergeNews([tagged]).slice(0, 100);
  });
}

async function getQuotes(symbols: string[]): Promise<Quote[]> {
  const uniq = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))].slice(0, 24);
  const rows = await mapLimit(uniq, 1, async (symbol) => {
    const quote = await fetchQuote(symbol);
    await sleep(120);
    return quote;
  });
  return rows.filter((q): q is Quote => Boolean(q));
}

function naverQuoteUrls(symbol: string): string[] {
  const root = symbol.replace(/\.(KS|KQ)$/i, "");
  if (/^\d{6}$/.test(root)) {
    return [
      `https://m.stock.naver.com/api/stock/${root}/basic`,
      `https://api.stock.naver.com/stock/${root}/basic`,
    ];
  }
  return [
    `https://api.stock.naver.com/stock/${root}/basic`,
    `https://api.stock.naver.com/stock/${root}.O/basic`,
    `https://api.stock.naver.com/stock/${root}.N/basic`,
  ];
}

function parseNaverQuote(symbol: string, raw: string): Quote | null {
  const data = JSON.parse(raw) as {
    closePrice?: string;
    fluctuationsRatio?: string;
    stockName?: string;
  };
  if (!data.closePrice) return null;
  const price = Number(String(data.closePrice).replace(/,/g, ""));
  const changePct = Number(String(data.fluctuationsRatio ?? "0").replace(/,/g, ""));
  if (!Number.isFinite(price)) return null;
  const kr = /\.K[SQ]$/i.test(symbol) || /^\d{6}/.test(symbol);
  return {
    symbol,
    price,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    currency: kr ? "KRW" : "USD",
    name: data.stockName || symbol,
  };
}

function parseYahooQuote(symbol: string, raw: string): Quote | null {
  const data = JSON.parse(raw) as {
    chart?: {
      result?: {
        meta?: {
          regularMarketPrice?: number;
          regularMarketChangePercent?: number;
          currency?: string;
          shortName?: string;
          longName?: string;
          chartPreviousClose?: number;
        };
      }[];
    };
  };
  const meta = data.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (price == null) return null;
  let changePct = meta?.regularMarketChangePercent;
  if (changePct == null && meta?.chartPreviousClose) {
    changePct = ((price - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
  }
  return {
    symbol,
    price,
    changePct: changePct ?? 0,
    currency: meta?.currency ?? "",
    name: meta?.shortName || meta?.longName || symbol,
  };
}

async function fetchQuote(symbol: string): Promise<Quote | null> {
  const hit = cache.get(`quote:${symbol}`);
  const ttl = hit?.data ? 60_000 : 8_000;
  if (hit && Date.now() - hit.at < ttl) return (hit.data as Quote | null) ?? null;

  let quote: Quote | null = null;
  for (const url of naverQuoteUrls(symbol)) {
    try {
      quote = parseNaverQuote(symbol, await fetchText(url, 7000));
      if (quote) break;
    } catch {
      /* try next venue suffix */
    }
  }
  if (!quote) {
    try {
      quote = parseYahooQuote(
        symbol,
        await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`),
      );
    } catch {
      quote = null;
    }
  }
  cache.set(`quote:${symbol}`, { at: Date.now(), data: quote });
  return quote;
}

async function searchSymbols(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(`search:${q.toLowerCase()}`, 60_000, async () => {
    try {
      const raw = await fetchText(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
      );
      const data = JSON.parse(raw) as {
        quotes?: {
          symbol?: string;
          shortname?: string;
          longname?: string;
          quoteType?: string;
          exchDisp?: string;
        }[];
      };
      return (data.quotes ?? [])
        .filter((x) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX"))
        .map((x) => {
          const yahoo = x.symbol!;
          const kr = yahoo.endsWith(".KS") || yahoo.endsWith(".KQ");
          const id = kr ? yahoo.replace(/\.(KS|KQ)$/i, "") : yahoo;
          const name = x.shortname || x.longname || yahoo;
          return {
            id,
            name,
            nameEn: x.longname || name,
            yahoo,
            market: kr ? "kr" as const : "us" as const,
          };
        });
    } catch {
      return [];
    }
  });
}

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
    json(res, { items: await getMarketNews(), fetchedAt: Date.now() });
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
