import { betterSnippet, needsKorean } from "./text";
import type { NewsItem, Quote, SourcePull } from "./types";

const KEY = "sihwang.archive.v1";
const DAY_MS = 86_400_000;

export interface NewsArchive {
  market: NewsItem[];
  stocks: NewsItem[];
  quotes: Quote[];
  pulls: SourcePull[];
  fetchedAt: number;
}

function emptyArchive(): NewsArchive {
  return { market: [], stocks: [], quotes: [], pulls: [], fetchedAt: 0 };
}

function newsKey(item: NewsItem): string {
  return item.url || item.id;
}

function sanitizeItem(item: NewsItem): NewsItem {
  return { ...item, snippet: betterSnippet(item.snippet, "", item.title) };
}

function combineNews(previous: NewsItem, incoming: NewsItem): NewsItem {
  let title = incoming.title;
  let titleEn = incoming.titleEn ?? previous.titleEn;
  if (needsKorean(incoming.title) && !needsKorean(previous.title)) {
    title = previous.title;
    titleEn = incoming.titleEn ?? incoming.title;
  } else if (!needsKorean(incoming.title) && needsKorean(previous.title)) {
    titleEn = incoming.titleEn ?? previous.titleEn ?? previous.title;
  }
  if (titleEn && titleEn === title) titleEn = undefined;
  return {
    ...incoming,
    title,
    titleEn,
    snippet: betterSnippet(incoming.snippet, previous.snippet, title),
    tags: incoming.tags.length ? incoming.tags : previous.tags,
    impact: Math.max(incoming.impact, previous.impact),
    stockIds: [...new Set([...incoming.stockIds, ...previous.stockIds])],
  };
}

export function pruneNews(items: NewsItem[], now = Date.now()): NewsItem[] {
  const seen = new Set<string>();
  return items
    .map(sanitizeItem)
    .filter((item) => Number.isFinite(item.publishedAt) && now - item.publishedAt <= DAY_MS)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter((item) => {
      const key = newsKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 250);
}

export function mergeNews(previous: NewsItem[], incoming: NewsItem[], now = Date.now()): NewsItem[] {
  const map = new Map<string, NewsItem>();
  for (const item of previous) map.set(newsKey(item), item);
  for (const item of incoming) {
    const prev = map.get(newsKey(item));
    map.set(newsKey(item), prev ? combineNews(prev, item) : sanitizeItem(item));
  }
  return pruneNews([...map.values()], now);
}

export function mergeQuotes(previous: Quote[], incoming: Quote[]): Quote[] {
  const map = new Map<string, Quote>();
  for (const q of previous) map.set(q.symbol, q);
  for (const q of incoming) map.set(q.symbol, q);
  return [...map.values()];
}

export function mergePulls(previous: SourcePull[], incoming: SourcePull[]): SourcePull[] {
  const map = new Map<string, SourcePull>();
  for (const pull of previous) map.set(pull.source, pull);
  for (const pull of incoming) map.set(pull.source, pull);
  return [...map.values()].sort((a, b) => a.source.localeCompare(b.source, "ko"));
}

export function loadArchive(): NewsArchive {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "") as NewsArchive;
    if (!parsed || !Array.isArray(parsed.market)) return emptyArchive();
    return {
      market: pruneNews(parsed.market),
      stocks: pruneNews(parsed.stocks ?? []),
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      pulls: Array.isArray(parsed.pulls) ? parsed.pulls : [],
      fetchedAt: parsed.fetchedAt ?? 0,
    };
  } catch {
    return emptyArchive();
  }
}

export function saveArchive(archive: NewsArchive): void {
  const next: NewsArchive = {
    market: pruneNews(archive.market),
    stocks: pruneNews(archive.stocks),
    quotes: archive.quotes,
    pulls: archive.pulls ?? [],
    fetchedAt: archive.fetchedAt || Date.now(),
  };
  localStorage.setItem(KEY, JSON.stringify(next));
}
