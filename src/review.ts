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

function spanLabel(range: ReviewRange): string {
  if (range === "week") return "지난 일주일";
  if (range === "month") return "지난 한 달";
  return "지난 1년";
}

function themeSummary(tag: string, items: NewsItem[]): string {
  const lead = items[0];
  const next = items[1];
  const bits = [`${tag} 이슈가 ${items.length}건 모였습니다.`];
  if (lead) bits.push(lead.snippet ? summarizeText(`${lead.title}. ${lead.snippet}`, lead.title, 160) : lead.title);
  if (next) bits.push(next.title);
  return bits.filter(Boolean).join(" ").slice(0, 280);
}

export function buildPeriodReview(items: NewsItem[], range: ReviewRange): PeriodReview {
  const { from, to } = rangeWindow(range);
  const ranked = [...items].sort((a, b) => b.impact - a.impact || b.publishedAt - a.publishedAt);
  const buckets = new Map<string, NewsItem[]>();
  for (const item of ranked) {
    const tag = item.tags[0] || "증시";
    const list = buckets.get(tag) ?? [];
    list.push(item);
    buckets.set(tag, list);
  }
  const themes: ReviewTheme[] = [...buckets.entries()]
    .map(([tag, rows]) => {
      const events = rows.slice(0, 3).map(toEvent);
      const tone = classifyTone(rows.slice(0, 4).map((r) => r.title).join(" ")).tone;
      return {
        tag,
        summary: themeSummary(tag, rows),
        tone,
        count: rows.length,
        events,
      };
    })
    .sort((a, b) => b.count - a.count || (b.events[0]?.impact ?? 0) - (a.events[0]?.impact ?? 0))
    .slice(0, 6);

  const seen = new Set<string>();
  const timeline = ranked
    .filter((item) => item.impact >= 16 || item.tags.length > 0)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, 14)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map(toEvent);

  const topTags = themes.slice(0, 3).map((t) => t.tag);
  const lead = timeline[0];
  const headline = lead
    ? `${spanLabel(range)} 시장은 ${topTags.join("·") || "증시"} 이슈가 중심에 있었습니다. 가장 무게 있는 소식은 “${lead.title}”입니다.`
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
  const ranges: ReviewRange[] = ["week", "month", "year"];
  const parts = await Promise.all(ranges.map(async (range) => {
    const items = await translateNews(await getPeriodNews(range));
    const top = items.filter((n) => n.impact >= 16).slice(0, 8);
    const filled = await enrichSnippets(top);
    const byId = new Map(filled.map((n) => [n.id, n]));
    const merged = items.map((n) => byId.get(n.id) ?? n);
    return [range, buildPeriodReview(merged, range)] as const;
  }));
  const map = Object.fromEntries(parts) as Record<ReviewRange, PeriodReview>;
  return { week: map.week, month: map.month, year: map.year, fetchedAt: Date.now() };
}
