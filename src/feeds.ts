import { classifyTone, inferRegion, isMarketRelevant, isOffTopicNews, scoreImpact } from "./impact";
import { extractArticleText, extractCanonicalUrl, extractPublishedAt, stripHtml, summarizeText } from "./text";
import { parseNewsDate, pickPublishedAt, rangeWindow } from "./time";
import type { NewsItem, Quote, SearchHit, SourcePull, ReviewRange } from "./types";

const isBrowser = typeof window !== "undefined";

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

function proxyUrls(url: string): string[] {
  return [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
}

async function fetchText(url: string, timeoutMs = 9000): Promise<string> {
  const targets = isBrowser ? proxyUrls(url) : [url];
  let lastError = "fetch failed";
  for (const target of targets) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/rss+xml, application/xml, text/xml, application/json, */*",
        };
        if (!isBrowser) headers["User-Agent"] = UA;
        const res = await fetch(target, { signal: ctrl.signal, headers });
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
        if (/^4\d\d\s/.test(lastError) && !isBrowser) throw err instanceof Error ? err : new Error(lastError);
        if (attempt < 1) await sleep(250 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(lastError);
}

function decode(raw: string): string {
  return stripHtml(raw);
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

const HOST_LABEL: Record<string, string> = {
  "v.daum.net": "다음",
  "news.daum.net": "다음",
  "n.news.naver.com": "네이버",
  "news.naver.com": "네이버",
  "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제",
  "yna.co.kr": "연합뉴스",
  "mt.co.kr": "머니투데이",
  "chosun.com": "조선일보",
  "biz.chosun.com": "조선비즈",
  "donga.com": "동아일보",
  "hani.co.kr": "한겨레",
  "sbs.co.kr": "SBS",
  "jtbc.co.kr": "JTBC",
  "newsis.com": "뉴시스",
  "sedaily.com": "서울경제",
  "fnnews.com": "파이낸셜뉴스",
  "edaily.co.kr": "이데일리",
  "asiae.co.kr": "아시아경제",
  "heraldcorp.com": "헤럴드경제",
  "wowtv.co.kr": "한국경제TV",
  "yonhapnewstv.co.kr": "연합뉴스TV",
  "ytn.co.kr": "YTN",
  "mbn.co.kr": "MBN",
  "kbs.co.kr": "KBS",
  "imbc.com": "MBC",
  "joongang.co.kr": "중앙일보",
  "joins.com": "중앙일보",
  "khan.co.kr": "경향신문",
  "hankookilbo.com": "한국일보",
  "seoul.co.kr": "서울신문",
  "kmib.co.kr": "국민일보",
  "bizwatch.co.kr": "비즈워치",
  "thebell.co.kr": "더벨",
  "bloombergtv.co.kr": "블룸버그",
  "bloomberg.com": "Bloomberg",
  "reuters.com": "Reuters",
  "wsj.com": "WSJ",
  "ft.com": "FT",
  "cnbc.com": "CNBC",
  "bbc.com": "BBC",
  "bbc.co.uk": "BBC",
  "nytimes.com": "NYT",
};

function prettySource(name: string): string {
  const trimmed = name.replace(/^www\./i, "").trim();
  const key = trimmed.toLowerCase();
  if (HOST_LABEL[key]) return HOST_LABEL[key];
  const parts = key.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join(".");
    if (HOST_LABEL[suffix]) return HOST_LABEL[suffix];
  }
  return trimmed;
}

function sourceOf(block: string, title: string, url: string): string {
  const src = tagText(block, "source");
  if (src) return prettySource(src);
  const dash = title.match(/\s[-–—]\s([^-–—]{2,40})$/);
  if (dash) return prettySource(dash[1].trim());
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return prettySource(host);
  } catch {
    return "";
  }
}

function stripSource(title: string, source: string): string {
  let t = title.replace(/\s[-–—−－]\s[^-–—−－]{2,40}$/, "").trim();
  if (source && t.endsWith(source)) t = t.slice(0, -source.length).trim();
  return t || title;
}

function rssRaw(block: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  return block.match(re)?.[1] ?? "";
}

function rssSnippet(block: string, title: string): string {
  for (const name of ["content:encoded", "content", "description", "summary", "media:description"]) {
    let raw = rssRaw(block, name);
    if (!raw) continue;
    raw = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    raw = raw.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ");
    raw = raw.replace(/<font\b[^>]*>[\s\S]*?<\/font>/gi, " ");
    const text = summarizeText(raw, title, 420);
    if (text.length >= 40) return text;
  }
  return "";
}

function rssDate(block: string): number {
  const attr = block.match(/datetime=["']([^"']+)["']/i)?.[1] ?? "";
  const raws = ["pubDate", "published", "updated", "dc:date", "date"].map((name) => rssRaw(block, name));
  for (const raw of [attr, ...raws]) {
    const t = parseNewsDate(raw);
    if (t) return t;
  }
  return 0;
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
    const snippet = rssSnippet(block, title);
    const publishedAt = rssDate(block);
    const { score, tags } = scoreImpact(title, snippet);
    items.push({
      id: hash(`${url}|${title}`),
      title,
      url,
      source,
      publishedAt,
      snippet,
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

function mergeNews(groups: NewsItem[][], maxAgeMs = 86_400_000): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  const now = Date.now();
  for (const item of groups.flat()) {
    if (item.title.replace(/\s+/g, "").length < 8) continue;
    if (item.publishedAt > 0 && now - item.publishedAt > maxAgeMs) continue;
    const key = normalizeTitle(item.title).slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}

const MARKET_FEEDS: { source: string; url: string; requireImpact: boolean }[] = [
  { source: "구글 뉴스", url: googleNews("when:1d (금리 OR 연준 OR FOMC OR 환율 OR 원달러 OR 유가 OR 관세 OR CPI)", "kr"), requireImpact: false },
  { source: "구글 뉴스", url: googleNews("when:1d (코스피 OR 나스닥 OR 증시 OR 반도체 OR 실적 OR 한국은행)", "kr"), requireImpact: false },
  { source: "구글 뉴스", url: googleNews('when:1d (Fed OR FOMC OR tariff OR CPI OR "stock market" OR Nasdaq OR earnings)', "us"), requireImpact: false },
  { source: "한국경제", url: "https://www.hankyung.com/feed/finance", requireImpact: false },
  { source: "한국경제", url: "https://www.hankyung.com/feed/economy", requireImpact: false },
  { source: "연합뉴스", url: "https://www.yna.co.kr/rss/economy.xml", requireImpact: false },
  { source: "연합뉴스", url: "https://www.yna.co.kr/rss/market.xml", requireImpact: false },
  { source: "머니투데이", url: "https://rss.mt.co.kr/mt_news.xml", requireImpact: false },
  { source: "조선일보", url: "https://www.chosun.com/arc/outboundfeeds/rss/category/economy/?outputType=xml", requireImpact: false },
  { source: "조선비즈", url: "https://biz.chosun.com/arc/outboundfeeds/rss/?outputType=xml", requireImpact: false },
  { source: "동아일보", url: "https://rss.donga.com/economy.xml", requireImpact: false },
  { source: "한겨레", url: "https://www.hani.co.kr/rss/economy", requireImpact: false },
  { source: "뉴시스", url: "https://www.newsis.com/RSS/economy.xml", requireImpact: false },
  { source: "SBS", url: "https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=02", requireImpact: false },
  { source: "JTBC", url: "https://fs.jtbc.co.kr/RSS/economy.xml", requireImpact: false },
  { source: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", requireImpact: true },
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml", requireImpact: true },
];

function foldPulls(rows: SourcePull[]): SourcePull[] {
  const map = new Map<string, SourcePull>();
  for (const pull of rows) {
    const cur = map.get(pull.source);
    if (!cur) {
      map.set(pull.source, { ...pull });
      continue;
    }
    map.set(pull.source, {
      source: pull.source,
      fetchedAt: Math.max(cur.fetchedAt, pull.fetchedAt),
      count: cur.count + pull.count,
      ok: cur.ok || pull.ok,
    });
  }
  return [...map.values()].sort((a, b) => a.source.localeCompare(b.source, "ko"));
}

export async function getMarketNews(): Promise<{ items: NewsItem[]; pulls: SourcePull[] }> {
  return cached("market", CACHE_MS, async () => {
    const feeds = isBrowser ? MARKET_FEEDS.slice(0, 8) : MARKET_FEEDS;
    const pulls: SourcePull[] = [];
    const groups = await settled(
      feeds.map(async (feed) => {
        const at = Date.now();
        try {
          const items = await rss(feed.url, feed.source);
          const kept = feed.requireImpact
            ? items.filter((n) => isMarketRelevant(n.title, n.snippet, n.impact))
            : items;
          pulls.push({ source: feed.source, fetchedAt: at, count: kept.length, ok: true });
          return kept;
        } catch {
          pulls.push({ source: feed.source, fetchedAt: at, count: 0, ok: false });
          return [];
        }
      }),
    );
    return {
      items: mergeNews(groups)
        .filter((n) => n.publishedAt <= 0 || Date.now() - n.publishedAt < 86_400_000)
        .slice(0, 250),
      pulls: foldPulls(pulls),
    };
  });
}

function afterQuery(from: number): string {
  const d = new Date(from);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `after:${y}-${m}-${day}`;
}

export async function getPeriodNews(range: ReviewRange): Promise<NewsItem[]> {
  return cached(`period:${range}`, CACHE_MS, async () => {
    const { maxAgeMs, from } = rangeWindow(range);
    const when = afterQuery(from);
    const feeds = [
      { source: "구글 뉴스", url: googleNews(`${when} (금리 OR 연준 OR FOMC OR 환율 OR 유가 OR 관세 OR CPI)`, "kr") },
      { source: "구글 뉴스", url: googleNews(`${when} (코스피 OR 반도체 OR 실적 OR 한국은행 OR 증시)`, "kr") },
      { source: "구글 뉴스", url: googleNews(`${when} (Fed OR FOMC OR tariff OR CPI OR Nasdaq OR earnings OR inflation)`, "us") },
    ];
    const groups = await settled(
      feeds.map(async (feed) => {
        try {
          return await rss(feed.url, feed.source);
        } catch {
          return [];
        }
      }),
    );
    const cap = range === "year" ? 140 : 100;
    return mergeNews(groups, maxAgeMs)
      .filter((n) => !isOffTopicNews(n.title, n.snippet))
      .filter((n) => n.impact >= 12 || isMarketRelevant(n.title, n.snippet, n.impact))
      .slice(0, cap);
  });
}

async function articleSummary(url: string, title: string): Promise<{ snippet: string; publishedAt: number }> {
  try {
    let html = await fetchText(url, 5500);
    if (/news\.google\.com/i.test(url)) {
      const target = extractCanonicalUrl(html, url);
      if (target !== url) html = await fetchText(target, 5500);
    }
    return {
      snippet: summarizeText(extractArticleText(html), title, 420),
      publishedAt: extractPublishedAt(html),
    };
  } catch {
    return { snippet: "", publishedAt: 0 };
  }
}

export async function enrichSnippets(items: NewsItem[]): Promise<NewsItem[]> {
  if (isBrowser) {
    return items.map((item) => ({ ...item, snippet: summarizeText(item.snippet, item.title) }));
  }
  const need = items
    .filter((item) => summarizeText(item.snippet, item.title).length < 48 || item.publishedAt <= 0)
    .slice(0, 40);
  const found = new Map<string, string>();
  const dates = new Map<string, number>();
  await mapLimit(need, 5, async (item) => {
    const meta = await articleSummary(item.url, item.title);
    if (meta.snippet.length >= 40) found.set(item.id, meta.snippet);
    if (meta.publishedAt > 0) dates.set(item.id, meta.publishedAt);
    await sleep(50);
  });
  console.log(`snippets ${found.size}/${need.length}`);
  return items.map((item) => ({
    ...item,
    snippet: found.get(item.id) || summarizeText(item.snippet, item.title),
    publishedAt: pickPublishedAt(item.publishedAt, dates.get(item.id) ?? 0),
  }));
}

export interface StockQuery {
  id: string;
  name: string;
  nameEn: string;
  yahoo: string;
  aliases: string[];
  market: "kr" | "us";
}

const WEAK_ALIAS = new Set([
  "samsung", "삼성", "hyundai", "현대", "kia", "apple", "google", "meta", "amazon",
  "하나", "신한", "kb", "sk", "lg", "cj", "sm", "nc", "kt", "arm",
]);

function googleQuery(stock: StockQuery, locale: "kr" | "us"): string {
  const aliases = stock.aliases.filter((a) => a.length >= 3 && !WEAK_ALIAS.has(a.toLowerCase()));
  const tokens = [stock.name, stock.nameEn, stock.id, ...aliases];
  if (stock.market === "us") tokens.push(stock.yahoo);
  const quoted = [...new Set(tokens.filter(Boolean))].slice(0, 5).map((n) => `"${n}"`);
  const exclude = locale === "kr"
    ? "-라이온즈 -야구 -KBO -프로야구"
    : "-baseball -lions -KBO";
  return `when:7d (${quoted.join(" OR ")}) ${exclude}`;
}

function mentionsStock(item: NewsItem, stock: StockQuery): boolean {
  const text = `${item.title} ${item.snippet}`;
  const lower = text.toLowerCase();
  if (stock.id.length >= 4 && lower.includes(stock.id.toLowerCase())) return true;
  if (stock.name.length >= 3 && text.includes(stock.name)) return true;
  if (stock.nameEn.length >= 5 && lower.includes(stock.nameEn.toLowerCase())) return true;
  if (stock.market === "us") {
    const ticker = stock.yahoo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${ticker}\\b`, "i").test(text)) return true;
  }
  return stock.aliases.some((alias) => {
    if (alias.length < 3 || WEAK_ALIAS.has(alias.toLowerCase())) return false;
    return lower.includes(alias.toLowerCase());
  });
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
          publishedAt: (n.providerPublishTime ?? 0) * 1000 || 0,
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

export async function getStockNews(stocks: StockQuery[], opts?: { light?: boolean }): Promise<NewsItem[]> {
  const light = Boolean(opts?.light) || isBrowser;
  const key = `stocks:${light ? "l:" : ""}${stocks.map((s) => s.id).sort().join(",")}`;
  return cached(key, CACHE_MS, async () => {
    const groups = await mapLimit(stocks, 5, async (stock) => {
      const rows: NewsItem[] = [];
      try {
        const kr = await rss(googleNews(googleQuery(stock, "kr"), "kr"), "Google 뉴스");
        rows.push(...kr.map((n) => ({ ...n, stockIds: [stock.id] })));
      } catch { /* skip one feed */ }
      if (!light) {
        try {
          const us = await rss(googleNews(googleQuery(stock, "us"), "us"), "Google News");
          rows.push(...us.map((n) => ({ ...n, stockIds: [stock.id] })));
        } catch { /* skip */ }
        if (stock.market === "us") {
          rows.push(...(await yahooTickerNews(stock.yahoo)));
        }
      }
      return rows;
    });
    const tagged: NewsItem[] = [];
    for (const item of groups.flat()) {
      if (isOffTopicNews(item.title, item.snippet)) continue;
      const matched = stocks.filter((s) => mentionsStock(item, s));
      if (matched.length === 0) continue;
      if (isGenericTitle(item.title, stocks)) continue;
      const ids = [...new Set([...item.stockIds, ...matched.map((s) => s.id)])];
      const names = matched.flatMap((s) => [s.name, s.nameEn, s.id, ...s.aliases]).filter(Boolean);
      tagged.push({
        ...item,
        stockIds: ids,
        tone: classifyTone(item.title, item.snippet, names).tone,
      });
    }
    return mergeNews([tagged]).slice(0, 250);
  });
}

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
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

export async function searchSymbols(query: string): Promise<SearchHit[]> {
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
