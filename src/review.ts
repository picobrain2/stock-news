import { enrichSnippets, getPeriodNews } from "./feeds";
import { classifyTone } from "./impact";
import { summarizeText } from "./text";
import { rangeWindow } from "./time";
import { translateNews } from "./translate";
import type { NewsItem, PeriodReview, ReviewBundle, ReviewEvent, ReviewRange, ReviewTheme } from "./types";

function toEvent(item: NewsItem): ReviewEvent {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    snippet: item.snippet,
    tags: item.tags,
    impact: item.impact,
    tone: item.tone,
  };
}

export function spanLabel(range: ReviewRange): string {
  if (range === "day") return "오늘";
  if (range === "week") return "지난 일주일";
  if (range === "month") return "지난 한 달";
  return "지난 1년";
}

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 6)
    .join(" ");
}

function clusterNews(items: NewsItem[]): Array<{ key: string; items: NewsItem[]; impact: number }> {
  const buckets = new Map<string, NewsItem[]>();
  for (const item of items) {
    const key = titleKey(item.title) || item.tags[0] || item.id;
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([key, rows]) => {
      const sorted = [...rows].sort((a, b) => b.impact - a.impact || b.publishedAt - a.publishedAt);
      const impact = Math.max(...sorted.map((r) => r.impact)) + Math.min(8, sorted.length - 1) * 2;
      return { key, items: sorted, impact };
    })
    .sort((a, b) => b.items.length - a.items.length || b.impact - a.impact);
}

function themeSummary(tag: string, items: NewsItem[]): string {
  const lead = items[0];
  const next = items[1];
  const bits = [`${tag} 관련 소식이 ${items.length}건으로 가장 많이 잡혔습니다.`];
  if (lead) bits.push(lead.snippet ? summarizeText(`${lead.title}. ${lead.snippet}`, lead.title, 160) : lead.title);
  if (next && next.id !== lead?.id) bits.push(`이어서 “${next.title}”도 주목됐습니다.`);
  return bits.filter(Boolean).join(" ").slice(0, 280);
}

function pickDiverseTimeline(items: NewsItem[], range: ReviewRange): NewsItem[] {
  const clusters = clusterNews(items.filter((item) => item.impact >= (range === "day" ? 10 : 14) || item.tags.length > 0));
  const ranked = clusters.map((c) => c.items[0]!).filter(Boolean);
  const limit = range === "day" ? 10 : range === "week" ? 12 : 14;

  if (range === "day" || range === "week") {
    return ranked
      .sort((a, b) => b.impact - a.impact || b.publishedAt - a.publishedAt)
      .slice(0, limit)
      .sort((a, b) => b.publishedAt - a.publishedAt);
  }

  const span = range === "month" ? 7 * 86_400_000 : 30 * 86_400_000;
  const buckets = new Map<number, NewsItem[]>();
  for (const item of ranked) {
    const slot = Math.floor(item.publishedAt / span);
    const list = buckets.get(slot) ?? [];
    list.push(item);
    buckets.set(slot, list);
  }
  const picked: NewsItem[] = [];
  const seen = new Set<string>();
  for (const rows of [...buckets.values()].sort((a, b) => (b[0]?.publishedAt ?? 0) - (a[0]?.publishedAt ?? 0))) {
    const top = [...rows].sort((a, b) => b.impact - a.impact)[0];
    if (!top || seen.has(top.id)) continue;
    seen.add(top.id);
    picked.push(top);
  }
  for (const item of ranked) {
    if (picked.length >= limit) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
  }
  return picked.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit);
}

export function buildPeriodReview(items: NewsItem[], range: ReviewRange): PeriodReview {
  const { from, to } = rangeWindow(range);
  const clusters = clusterNews(items);
  const tagBuckets = new Map<string, NewsItem[]>();
  for (const cluster of clusters) {
    const tag = cluster.items[0]?.tags[0] || "증시";
    const list = tagBuckets.get(tag) ?? [];
    list.push(...cluster.items);
    tagBuckets.set(tag, list);
  }

  const themes: ReviewTheme[] = [...tagBuckets.entries()]
    .map(([tag, rows]) => {
      const clustered = clusterNews(rows);
      const leadItems = clustered.flatMap((c) => c.items.slice(0, 1)).slice(0, 3);
      const tone = classifyTone(leadItems.map((r) => r.title).join(" ")).tone;
      return {
        tag,
        summary: themeSummary(tag, clustered[0]?.items ?? rows),
        tone,
        count: rows.length,
        events: leadItems.map(toEvent),
      };
    })
    .sort((a, b) => b.count - a.count || (b.events[0]?.impact ?? 0) - (a.events[0]?.impact ?? 0))
    .slice(0, range === "day" ? 5 : 6);

  const timeline = pickDiverseTimeline(items, range).map(toEvent);
  const topTags = themes.slice(0, 3).map((t) => t.tag);
  const hottest = clusters[0];
  const lead = hottest?.items[0] ?? (timeline[0] ? items.find((i) => i.id === timeline[0]!.id) : undefined);
  const freqNote = hottest && hottest.items.length >= 2
    ? `가장 많이 다뤄진 사건은 ${hottest.items.length}건이 모인 “${hottest.items[0]!.title}”입니다.`
    : lead
      ? `가장 무게 있는 소식은 “${lead.title}”입니다.`
      : "";
  const headline = lead
    ? `${spanLabel(range)} 시장은 ${topTags.join("·") || "증시"} 이슈가 중심에 있었습니다. ${freqNote}`.trim()
    : `${spanLabel(range)} 동안 시장을 움직인 굵은 소식이 아직 모이지 않았습니다.`;

  return {
    range,
    from,
    to,
    headline,
    themes,
    timeline,
    fetchedAt: Date.now(),
  };
}

export async function buildReviewBundle(): Promise<ReviewBundle> {
  const ranges: ReviewRange[] = ["day", "week", "month", "year"];
  const parts = await Promise.all(ranges.map(async (range) => {
    const items = await translateNews(await getPeriodNews(range));
    const top = items.filter((n) => n.impact >= (range === "day" ? 12 : 16)).slice(0, range === "day" ? 10 : 8);
    const filled = await enrichSnippets(top);
    const byId = new Map(filled.map((n) => [n.id, n]));
    const merged = items.map((n) => byId.get(n.id) ?? n);
    return [range, buildPeriodReview(merged, range)] as const;
  }));
  const map = Object.fromEntries(parts) as Record<ReviewRange, PeriodReview>;
  return {
    day: map.day,
    week: map.week,
    month: map.month,
    year: map.year,
    fetchedAt: Date.now(),
  };
}
