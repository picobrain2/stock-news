export type Market = "kr" | "us";
export type Region = "kr" | "us" | "global";
export type Tab = "market" | "mine";
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

export interface SearchHit {
  id: string;
  name: string;
  nameEn: string;
  yahoo: string;
  market: Market;
}
