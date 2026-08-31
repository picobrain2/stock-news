export type Market = "kr" | "us";
export type Region = "kr" | "us" | "global";
export type Tab = "market" | "mine" | "review";
export type ReviewRange = "week" | "month" | "year";
export type Tone = "up" | "down" | "mixed";

export interface Stock {
  id: string;
  name: string;
  nameEn: string;
  aliases: string[];
  yahoo: string;
  market: Market;
  popular: boolean;
}

export interface NewsItem {
  id: string;
  title: string;
  titleEn?: string;
  url: string;
  source: string;
  publishedAt: number;
  snippet: string;
  tags: string[];
  region: Region;
  stockIds: string[];
  impact: number;
  tone: Tone;
}

export interface SourcePull {
  source: string;
  fetchedAt: number;
  count: number;
  ok: boolean;
}

export interface Quote {
  symbol: string;
  price: number;
  changePct: number;
  currency: string;
  name: string;
}

export interface IndexQuote {
  id: string;
  name: string;
  symbol: string;
  price: number;
  changePct: number;
  currency: string;
  spark: number[];
}

export interface SearchHit {
  id: string;
  name: string;
  nameEn: string;
  yahoo: string;
  market: Market;
  price?: number;
  changePct?: number;
  currency?: string;
}

export interface StockStat {
  label: string;
  value: string;
}

export interface StockDetail {
  id: string;
  name: string;
  price: number;
  changePct: number;
  change?: string;
  currency: string;
  exchange: string;
  stats: StockStat[];
  targetPrice?: string;
  recommend?: string;
  naverUrl: string;
}

export interface ReviewEvent {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  snippet: string;
  tags: string[];
  impact: number;
  tone: Tone;
}

export interface ReviewTheme {
  tag: string;
  summary: string;
  tone: Tone;
  count: number;
  events: ReviewEvent[];
}

export interface PeriodReview {
  range: ReviewRange;
  from: number;
  to: number;
  headline: string;
  themes: ReviewTheme[];
  timeline: ReviewEvent[];
  fetchedAt: number;
}

export interface ReviewBundle {
  week: PeriodReview | null;
  month: PeriodReview | null;
  year: PeriodReview | null;
  fetchedAt: number;
}
