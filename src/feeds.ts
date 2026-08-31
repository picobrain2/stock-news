import { isGoogleNewsBoilerplate, isGoogleNewsUrl, resolveGoogleNewsUrl } from "./googleNews";
import { classifyTone, inferRegion, isMarketRelevant, isOffTopicNews, scoreImpact } from "./impact";
import { downsample, INDEX_SPECS, type IndexSpec } from "./indices";
import { extractArticleText, extractPublishedAt, stripHtml, summarizeText } from "./text";
import { parseNewsDate, pickPublishedAt, rangeWindow } from "./time";
import type { IndexQuote, NewsItem, Quote, SearchHit, SourcePull, ReviewRange } from "./types";

const isBrowser = typeof window !== "undefined";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 90_000;
export const INDEX_REFRESH_MS = 15_000;
const INDEX_CACHE_MS = 12_000;

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
    `https://r.jina.ai/${url}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
}

function unwrapBody(raw: string): string {
  let text = raw.trim();
  const jina = text.match(/Markdown Content:\s*\r?\n([\s\S]*)/i);
  if (jina?.[1]) text = jina[1].trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    const obj = JSON.parse(text) as {
      contents?: string;
      data?: { content?: string };
    };
    if (typeof obj.data?.content === "string" && obj.data.content) return obj.data.content;
    if (typeof obj.contents === "string" && obj.contents) return obj.contents;
  } catch {
    return text;
  }
  return text;
}

async function fetchVia(target: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      headers: { Accept: "application/json, text/plain, application/xml, */*" },
    });
    if (res.status === 429 || res.status === 409) throw new Error(String(res.status));
    if (!res.ok) throw new Error(`${res.status}`);
    const text = unwrapBody(await res.text());
    if (!text.trim()) throw new Error("empty");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeoutMs = 5000): Promise<string> {
  if (!isBrowser) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json, application/xml, */*", "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const proxies = proxyUrls(url);
  const fastMs = Math.min(timeoutMs, 3500);
  try {
    return await Promise.any(proxies.map((target) => fetchVia(target, fastMs)));
  } catch {
    let lastError = "fetch failed";
    for (const target of proxies) {
      try {
        return await fetchVia(target, timeoutMs);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(lastError);
  }
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

async function articleSummary(url: string, title: string): Promise<{ snippet: string; publishedAt: number; url?: string }> {
  try {
    let target = url;
    if (isGoogleNewsUrl(url)) {
      const resolved = await resolveGoogleNewsUrl(url, fetchText);
      if (!resolved) return { snippet: "", publishedAt: 0 };
      target = resolved;
    }
    const html = await fetchText(target, 5500);
    if (/news\.google\.com/i.test(target)) return { snippet: "", publishedAt: 0 };
    const snippet = summarizeText(extractArticleText(html), title, 420);
    if (isGoogleNewsBoilerplate(snippet)) return { snippet: "", publishedAt: 0 };
    return {
      snippet,
      publishedAt: extractPublishedAt(html),
      url: target !== url ? target : undefined,
    };
  } catch {
    return { snippet: "", publishedAt: 0 };
  }
}

function needsSnippetFetch(item: NewsItem): boolean {
  const snippet = summarizeText(item.snippet, item.title);
  if (item.publishedAt <= 0) return true;
  if (snippet.length < 48) return true;
  if (isGoogleNewsBoilerplate(snippet)) return true;
  if (isGoogleNewsUrl(item.url)) return true;
  return false;
}

export async function enrichSnippets(items: NewsItem[]): Promise<NewsItem[]> {
  if (isBrowser) {
    return items.map((item) => ({
      ...item,
      snippet: isGoogleNewsBoilerplate(item.snippet) ? "" : summarizeText(item.snippet, item.title),
    }));
  }
  const need = items.filter((item) => needsSnippetFetch(item)).slice(0, 48);
  const found = new Map<string, string>();
  const dates = new Map<string, number>();
  const urls = new Map<string, string>();
  await mapLimit(need, 4, async (item) => {
    const meta = await articleSummary(item.url, item.title);
    if (meta.snippet.length >= 40) found.set(item.id, meta.snippet);
    if (meta.publishedAt > 0) dates.set(item.id, meta.publishedAt);
    if (meta.url) urls.set(item.id, meta.url);
    await sleep(40);
  });
  console.log(`snippets ${found.size}/${need.length}`);
  return items.map((item) => {
    const snippet = found.get(item.id)
      ?? (isGoogleNewsBoilerplate(item.snippet) ? "" : summarizeText(item.snippet, item.title));
    return {
      ...item,
      snippet,
      url: urls.get(item.id) ?? item.url,
      publishedAt: pickPublishedAt(item.publishedAt, dates.get(item.id) ?? 0),
    };
  });
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
  const rows = await Promise.all(uniq.map((symbol) => fetchQuote(symbol)));
  return rows.filter((q): q is Quote => Boolean(q));
}

export async function getIndexBoard(): Promise<IndexQuote[]> {
  const rows = await Promise.all(INDEX_SPECS.map((spec) => fetchIndex(spec)));
  return rows.filter((row): row is IndexQuote => Boolean(row));
}

function yahooChartUrl(symbol: string, interval: string, range: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

function isKrSymbol(symbol: string): boolean {
  return /\.K[SQ]$/i.test(symbol) || /^\d{6}$/.test(symbol.replace(/\.(KS|KQ)$/i, ""));
}

type YahooMeta = {
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  currency?: string;
  shortName?: string;
  longName?: string;
};

type YahooChart = {
  chart?: {
    result?: {
      meta?: YahooMeta;
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
};

function yahooCloses(raw: string): { meta: YahooMeta; closes: number[] } | null {
  const data = JSON.parse(raw) as YahooChart;
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (n): n is number => n != null && Number.isFinite(n),
  );
  return { meta, closes };
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
  const kr = isKrSymbol(symbol);
  return {
    symbol,
    price,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    currency: kr ? "KRW" : "USD",
    name: data.stockName || symbol,
  };
}

function parseYahooQuote(symbol: string, raw: string): Quote | null {
  const parsed = yahooCloses(raw);
  if (!parsed) return null;
  const { meta, closes } = parsed;
  const price = meta?.regularMarketPrice ?? closes.at(-1);
  if (price == null) return null;
  let changePct = meta?.regularMarketChangePercent;
  const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? closes[0];
  if (changePct == null && prev) {
    changePct = ((price - prev) / prev) * 100;
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
  const ttl = hit?.data ? 60_000 : 3_000;
  if (hit && Date.now() - hit.at < ttl) return (hit.data as Quote | null) ?? null;

  const kr = isKrSymbol(symbol);
  let quote: Quote | null = null;

  const fromYahoo = async (): Promise<Quote | null> => {
    try {
      return parseYahooQuote(symbol, await fetchText(yahooChartUrl(symbol, "1d", "5d"), 7000));
    } catch {
      return null;
    }
  };
  const fromNaver = async (): Promise<Quote | null> => {
    if (!kr) return null;
    for (const url of naverQuoteUrls(symbol).slice(0, 2)) {
      try {
        const row = parseNaverQuote(symbol, await fetchText(url, 5000));
        if (row) return row;
      } catch {
        /* next */
      }
    }
    return null;
  };

  quote = (await fromNaver()) ?? (await fromYahoo());
  cache.set(`quote:${symbol}`, { at: Date.now(), data: quote });
  return quote;
}

async function fetchIndex(spec: IndexSpec): Promise<IndexQuote | null> {
  const hit = cache.get(`index:${spec.symbol}`);
  if (hit && Date.now() - hit.at < INDEX_CACHE_MS) return (hit.data as IndexQuote | null) ?? null;
  let row: IndexQuote | null = null;
  if (spec.naver) {
    try {
      row = await fetchNaverIndex(spec);
    } catch {
      row = null;
    }
  }
  if (!row) row = await fetchYahooIndex(spec);
  cache.set(`index:${spec.symbol}`, { at: Date.now(), data: row });
  return row;
}

function num(raw: unknown): number {
  const n = Number(String(raw ?? "").replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function sparkFrom(price: number, changePct: number, closes: number[]): number[] {
  const series = closes.filter((n) => Number.isFinite(n));
  if (series.length >= 2) return downsample(series, 56);
  const prev = changePct !== 0 ? price / (1 + changePct / 100) : price;
  return downsample([prev, price], 8);
}

function packIndex(spec: IndexSpec, price: number, changePct: number, currency: string, closes: number[]): IndexQuote | null {
  if (!Number.isFinite(price)) return null;
  return {
    id: spec.id,
    name: spec.name,
    symbol: spec.symbol,
    price,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    currency,
    spark: sparkFrom(price, changePct, closes),
  };
}

async function fetchNaverIndex(spec: IndexSpec): Promise<IndexQuote | null> {
  const src = spec.naver;
  if (!src) return null;
  if (src.kind === "kr") {
    const [basicRaw, histRaw] = await Promise.all([
      fetchText(`https://m.stock.naver.com/api/index/${src.code}/basic`, 4000),
      fetchText(`https://m.stock.naver.com/api/index/${src.code}/price?pageSize=40&timeFrame=day`, 4000).catch(() => "[]"),
    ]);
    const basic = JSON.parse(basicRaw) as { closePrice?: string; fluctuationsRatio?: string };
    const hist = JSON.parse(histRaw) as { closePrice?: string }[];
    const closes = [...hist].reverse().map((row) => num(row.closePrice)).filter((n) => Number.isFinite(n));
    return packIndex(spec, num(basic.closePrice), num(basic.fluctuationsRatio), "KRW", closes);
  }
  if (src.kind === "world") {
    const [basicRaw, chartRaw] = await Promise.all([
      fetchText(`https://api.stock.naver.com/index/${src.code}/basic`, 4000),
      fetchText(`https://api.stock.naver.com/chart/foreign/index/${src.code}?periodType=day&count=5`, 5000).catch(() => "{}"),
    ]);
    const basic = JSON.parse(basicRaw) as { closePrice?: string; fluctuationsRatio?: string };
    const chart = JSON.parse(chartRaw) as { lastClosePrice?: number; priceInfos?: { currentPrice?: number }[] };
    const closes = (chart.priceInfos ?? []).map((row) => num(row.currentPrice)).filter((n) => Number.isFinite(n));
    return packIndex(spec, num(basic.closePrice) || num(chart.lastClosePrice), num(basic.fluctuationsRatio), "USD", closes);
  }
  if (src.kind === "fx") {
    const data = JSON.parse(await fetchText(`https://api.stock.naver.com/marketindex/exchange/${src.code}`, 4000)) as {
      exchangeInfo?: { closePrice?: string; fluctuationsRatio?: string };
    };
    const info = data.exchangeInfo ?? {};
    return packIndex(spec, num(info.closePrice), num(info.fluctuationsRatio), "KRW", []);
  }
  if (src.kind === "oil") {
    const html = await fetchText(
      `https://finance.naver.com/marketindex/worldOilDetail.naver?marketindexCd=${src.code}&fdtc=2`,
      7000,
    );
    const price = parseNaverOilPrice(html);
    const changePct = parseNaverOilChangePct(html);
    if (price == null) return null;
    return packIndex(spec, price, changePct ?? 0, "USD", []);
  }
  return null;
}

function parseNaverOilPrice(html: string): number | null {
  const before = html.match(/([\s\S]{0,800})class="txt_barrel"/);
  const source = before?.[1] ?? html;
  const ems = [...source.matchAll(/<em class="no_(?:up|down|same)">([\s\S]*?)<\/em>/g)];
  const last = ems.at(-1);
  return last ? parseNaverDigits(last[1]) : null;
}

function parseNaverOilChangePct(html: string): number | null {
  const ems = [...html.matchAll(/<em class="no_(up|down|same)">([\s\S]*?)<\/em>/g)];
  for (const em of ems) {
    if (!em[2].includes("per")) continue;
    const n = parseNaverDigits(em[2]);
    if (n == null) continue;
    return em[1] === "down" || em[2].includes("minus") ? -Math.abs(n) : Math.abs(n);
  }
  return null;
}

function parseNaverDigits(html: string): number | null {
  let s = "";
  for (const m of html.matchAll(/class="(no\d|jum)"/g)) {
    s += m[1] === "jum" ? "." : m[1].slice(2);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchYahooIndex(spec: IndexSpec): Promise<IndexQuote | null> {
  let parsed: ReturnType<typeof yahooCloses> = null;
  for (const [interval, range] of [["15m", "5d"], ["1d", "1mo"]] as const) {
    try {
      parsed = yahooCloses(await fetchText(yahooChartUrl(spec.symbol, interval, range), 8000));
      if (parsed && (parsed.closes.length >= 2 || parsed.meta.regularMarketPrice != null)) break;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return null;
  const { meta, closes } = parsed;
  const price = meta.regularMarketPrice ?? closes.at(-1);
  if (price == null) return null;
  const prev = meta.previousClose ?? meta.chartPreviousClose ?? closes[0];
  const changePct = meta.regularMarketChangePercent ?? (prev ? ((price - prev) / prev) * 100 : 0);
  return packIndex(spec, price, changePct, meta.currency ?? "", closes);
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
          regularMarketPrice?: number;
          regularMarketChangePercent?: number;
        }[];
      };
      return (data.quotes ?? [])
        .filter((x) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX"))
        .map((x) => {
          const yahoo = x.symbol!;
          const kr = yahoo.endsWith(".KS") || yahoo.endsWith(".KQ");
          const id = kr ? yahoo.replace(/\.(KS|KQ)$/i, "") : yahoo;
          const name = x.shortname || x.longname || yahoo;
          const price = Number(x.regularMarketPrice);
          const changePct = Number(x.regularMarketChangePercent);
          return {
            id,
            name,
            nameEn: x.longname || name,
            yahoo,
            market: kr ? "kr" as const : "us" as const,
            price: Number.isFinite(price) ? price : undefined,
            changePct: Number.isFinite(changePct) ? changePct : undefined,
            currency: kr ? "KRW" : "USD",
          };
        });
    } catch {
      return [];
    }
  });
}
