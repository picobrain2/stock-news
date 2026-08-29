import { needsKorean } from "./text";
import type { NewsItem } from "./types";

const cache = new Map<string, string>();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function usable(source: string, translated: string): boolean {
  const out = translated.replace(/<t\d+\/?>/g, "").trim();
  if (!out || out.includes("MYMEMORY WARNING")) return false;
  if (out.toLowerCase() === source.toLowerCase()) return false;
  return !needsKorean(out);
}

function parseGoogle(data: unknown): string | null {
  if (typeof data === "string") return data.trim() || null;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first === "string") return first.trim() || null;
  if (Array.isArray(first) && typeof first[0] === "string") return first[0].trim() || null;
  return null;
}

async function translateViaGoogle(text: string): Promise<string | null> {
  const url = new URL("https://clients5.google.com/translate_a/t");
  url.searchParams.set("client", "dict-chrome-ex");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "ko");
  url.searchParams.set("q", text.slice(0, 500));
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (res.status === 429) throw new Error("429");
  if (!res.ok) return null;
  return parseGoogle(await res.json());
}

async function translateViaMyMemory(text: string): Promise<string | null> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text.slice(0, 480));
  url.searchParams.set("langpair", "en|ko");
  url.searchParams.set("de", "sihwang@users.noreply.github.com");
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { responseStatus?: number; responseData?: { translatedText?: string } };
  if (data.responseStatus !== 200) return null;
  return data.responseData?.translatedText?.trim() || null;
}

export async function translateToKo(text: string): Promise<string | null> {
  const source = text.trim();
  if (!source || !needsKorean(source)) return null;
  const hit = cache.get(source);
  if (hit) return hit;
  for (const attempt of [0, 1]) {
    try {
      const google = await translateViaGoogle(source);
      if (google && usable(source, google)) {
        cache.set(source, google);
        return google;
      }
      break;
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  try {
    const memory = await translateViaMyMemory(source);
    if (memory && usable(source, memory)) {
      cache.set(source, memory);
      return memory;
    }
  } catch {
    return null;
  }
  return null;
}

export async function translateNews(items: NewsItem[]): Promise<NewsItem[]> {
  const titleNeed = items.filter((item) => needsKorean(item.title)).slice(0, 120);
  const snipNeed = items.filter((item) => needsKorean(item.snippet)).slice(0, 80);
  const titles = new Map<string, string>();
  const snips = new Map<string, string>();
  await mapLimit(titleNeed, 3, async (item) => {
    const ko = await translateToKo(item.title);
    if (ko) titles.set(item.id, ko);
    await sleep(80);
  });
  await mapLimit(snipNeed, 3, async (item) => {
    const ko = await translateToKo(item.snippet);
    if (ko) snips.set(item.id, ko);
    await sleep(80);
  });
  console.log(`translate titles ${titles.size}/${titleNeed.length} snippets ${snips.size}/${snipNeed.length}`);
  return items.map((item) => {
    const title = titles.get(item.id);
    const snippet = snips.get(item.id);
    return {
      ...item,
      titleEn: title ? item.titleEn ?? item.title : item.titleEn,
      title: title ?? item.title,
      snippet: snippet ?? item.snippet,
    };
  });
}
