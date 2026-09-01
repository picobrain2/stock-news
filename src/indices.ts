import type { IndexQuote } from "./types";
import { formatSparkTime, isKrMarketOpen, isUsMarketOpen, minutesInTimeZone, tsAtSessionMinute, dateKeyInTimeZone } from "./time";

export type NaverIndex =
  | { kind: "kr"; code: string }
  | { kind: "world"; code: string }
  | { kind: "fx"; code: string }
  | { kind: "oil"; code: string };

export interface IndexSpec {
  id: string;
  name: string;
  symbol: string;
  naver?: NaverIndex;
  priceFormat?: "index" | "yield";
}

export const INDEX_SPECS: IndexSpec[] = [
  { id: "kospi", name: "코스피", symbol: "^KS11", naver: { kind: "kr", code: "KOSPI" } },
  { id: "kosdaq", name: "코스닥", symbol: "^KQ11", naver: { kind: "kr", code: "KOSDAQ" } },
  { id: "nasdaq", name: "나스닥", symbol: "^IXIC", naver: { kind: "world", code: ".IXIC" } },
  { id: "spx", name: "S&P 500", symbol: "^GSPC", naver: { kind: "world", code: ".INX" } },
  { id: "sox", name: "필라델피아 반도체", symbol: "^SOX", naver: { kind: "world", code: ".SOX" } },
  { id: "us10y", name: "미국채 10년", symbol: "^TNX", priceFormat: "yield" },
  { id: "nq", name: "나스닥 선물", symbol: "NQ=F" },
  { id: "es", name: "S&P 선물", symbol: "ES=F" },
  { id: "wti", name: "WTI 선물", symbol: "CL=F", naver: { kind: "oil", code: "OIL_CL" } },
  { id: "usdkrw", name: "원/달러", symbol: "KRW=X", naver: { kind: "fx", code: "FX_USDKRW" } },
];

export function indexSession(id: string): "kr" | "us" {
  if (id === "kospi" || id === "kosdaq" || id === "usdkrw") return "kr";
  return "us";
}

export const DISPLAY_TZ = "Asia/Seoul";

export const SESSION_BOUNDS = {
  kr: { tz: "Asia/Seoul", open: 9 * 60, close: 15 * 60 + 30 },
  us: { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
} as const;

export function downsample(values: number[], max = 56): number[] {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length <= max) return nums;
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (nums.length - 1)) / (max - 1));
    out.push(nums[idx]);
  }
  return out;
}

export function sparkPath(values: number[], width = 140, height = 36): string {
  const chart = buildSparkChart(values, width, height);
  return chart?.line ?? "";
}

function downsampleSeries(values: number[], times: number[] | undefined, max = 40): { values: number[]; times?: number[] } {
  if (values.length <= max) return { values, times };
  const outV: number[] = [];
  const outT: number[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (values.length - 1)) / (max - 1));
    outV.push(values[idx]!);
    if (times?.length) outT.push(times[idx]!);
  }
  return { values: outV, times: outT.length ? outT : undefined };
}

function sparkQuality(row: IndexQuote): number {
  if (!row.spark?.length) return 0;
  if (row.spark.length < 3) return row.spark.length;
  if (row.sparkAt?.length && row.sparkAt.length !== row.spark.length) return 1;
  const uniq = new Set(row.spark.map((v) => v.toFixed(2))).size;
  return row.spark.length + (uniq > 1 ? 20 : 0);
}

function sparkLastDate(row: Pick<IndexQuote, "sparkAt">, session: "kr" | "us"): string {
  const last = row.sparkAt?.at(-1);
  if (!last) return "";
  return dateKeyInTimeZone(last, SESSION_BOUNDS[session].tz);
}

function sessionToday(session: "kr" | "us", now = Date.now()): string {
  return dateKeyInTimeZone(now, SESSION_BOUNDS[session].tz);
}

function isWeekdayInTz(ts: number, tz: string): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ts));
  return wd !== "Sat" && wd !== "Sun";
}

function previousTradingDay(now: number, tz: string): string {
  let t = now - 86_400_000;
  for (let i = 0; i < 8; i++) {
    if (isWeekdayInTz(t, tz)) return dateKeyInTimeZone(t, tz);
    t -= 86_400_000;
  }
  return dateKeyInTimeZone(now, tz);
}

export function resolveSessionAxis(session: "kr" | "us", now = Date.now()): {
  tradeDate: string;
  start: number;
  close: number;
  labelStart: string;
  labelClose: string;
} {
  const { tz, open, close } = SESSION_BOUNDS[session];
  const openNow = session === "kr" ? isKrMarketOpen(new Date(now)) : isUsMarketOpen(new Date(now));
  const today = dateKeyInTimeZone(now, tz);
  const minNow = minutesInTimeZone(now, tz);
  let tradeDate = today;
  if (!openNow && minNow < open) tradeDate = previousTradingDay(now, tz);
  const start = tsAtSessionMinute(tradeDate, open, tz);
  const closeTs = tsAtSessionMinute(tradeDate, close, tz);
  return {
    tradeDate,
    start,
    close: closeTs,
    labelStart: formatSparkTime(start, DISPLAY_TZ),
    labelClose: formatSparkTime(closeTs, DISPLAY_TZ),
  };
}

export function sanitizeIndexRows(rows: IndexQuote[], now = Date.now()): IndexQuote[] {
  return rows.map((row) => {
    const session = indexSession(row.id);
    if (!isStaleSessionSpark(row, session, now)) return row;
    return { ...row, spark: [], sparkAt: undefined };
  });
}

export function isStaleSessionSpark(row: Pick<IndexQuote, "sparkAt">, session: "kr" | "us", now = Date.now()): boolean {
  const openNow = session === "kr" ? isKrMarketOpen(new Date(now)) : isUsMarketOpen(new Date(now));
  if (!openNow) return false;
  const lastDate = sparkLastDate(row, session);
  return Boolean(lastDate && lastDate < sessionToday(session, now));
}

export function mergeIndexQuote(prev: IndexQuote | undefined, incoming: IndexQuote): IndexQuote {
  if (!prev) return incoming;
  const session = indexSession(incoming.id);
  if (isStaleSessionSpark(prev, session)) prev = { ...prev, spark: [], sparkAt: undefined };
  const prevDate = sparkLastDate(prev, session);
  const incDate = sparkLastDate(incoming, session);
  const prevQ = sparkQuality(prev);
  const incQ = sparkQuality(incoming);
  const prevTs = prev.quoteTs ?? prev.sparkAt?.at(-1) ?? 0;
  const incTs = incoming.quoteTs ?? incoming.sparkAt?.at(-1) ?? 0;
  const useIncomingQuote = incTs >= prevTs;
  const prevSparkStale = isStaleSessionSpark(prev, session);

  if (incDate && prevDate && incDate > prevDate) {
    return useIncomingQuote ? incoming : { ...incoming, price: prev.price, changePct: prev.changePct, quoteTs: prev.quoteTs };
  }
  if (prevSparkStale && incQ <= 0) {
    return useIncomingQuote ? incoming : { ...incoming, price: prev.price, changePct: prev.changePct, quoteTs: prev.quoteTs };
  }

  let row: IndexQuote;
  if (incQ <= 0 && prevQ > 0 && !prevSparkStale) {
    row = {
      ...incoming,
      spark: prev.spark,
      sparkAt: prev.sparkAt,
      sparkTz: prev.sparkTz ?? incoming.sparkTz,
    };
  } else if (incQ >= prevQ) {
    row = incoming;
  } else {
    row = {
      ...incoming,
      spark: prev.spark,
      sparkAt: prev.sparkAt,
      sparkTz: prev.sparkTz ?? incoming.sparkTz,
    };
  }
  if (!useIncomingQuote) {
    row = { ...row, price: prev.price, changePct: prev.changePct, quoteTs: prev.quoteTs };
  }
  return row;
}

export interface SparkChart {
  line: string;
  area: string;
  width: number;
  height: number;
  labels: { start: string; end: string };
  min: number;
  max: number;
  lastX: number;
  lastY: number;
}

export function buildSparkChart(
  values: number[],
  width = 180,
  height = 58,
  times?: number[],
  session: "kr" | "us" = "kr",
  now = Date.now(),
): SparkChart | null {
  if (values.length < 2) return null;
  const axis = resolveSessionAxis(session, now);
  const { tz } = SESSION_BOUNDS[session];
  const openNow = session === "kr" ? isKrMarketOpen(new Date(now)) : isUsMarketOpen(new Date(now));
  const plotEnd = openNow && axis.tradeDate === dateKeyInTimeZone(now, tz) ? now : axis.close;
  const timeSpan = axis.close - axis.start || 1;

  let pairs: { v: number; t: number }[] = [];
  if (times?.length === values.length) {
    pairs = values
      .map((v, i) => ({ v, t: times[i]! }))
      .filter((p) => p.t >= axis.start - 60_000
        && p.t <= plotEnd + 60_000
        && dateKeyInTimeZone(p.t, tz) === axis.tradeDate);
  }
  if (pairs.length < 2) return null;

  const sampled = downsampleSeries(
    pairs.map((p) => p.v),
    pairs.map((p) => p.t),
    40,
  );
  const nums = sampled.values;
  const seriesTimes = sampled.times;
  if (!seriesTimes?.length || nums.length < 2) return null;

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const padY = 5;
  const innerH = height - padY * 2;
  const points = nums.map((v, i) => ({
    x: Math.max(0, Math.min(width, ((seriesTimes[i]! - axis.start) / timeSpan) * width)),
    y: padY + innerH - ((v - min) / span) * innerH,
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points[points.length - 1]!.x.toFixed(1)} ${height} L${points[0]!.x.toFixed(1)} ${height} Z`;
  const last = points[points.length - 1]!;
  return {
    line,
    area,
    width,
    height,
    labels: {
      start: axis.labelStart,
      end: axis.labelClose,
    },
    min,
    max,
    lastX: last.x,
    lastY: last.y,
  };
}

export function mergeIndices(previous: IndexQuote[], incoming: IndexQuote[], fallback: IndexQuote[] = []): IndexQuote[] {
  const map = new Map<string, IndexQuote>();
  for (const row of fallback) map.set(row.id, row);
  for (const row of previous) map.set(row.id, row);
  for (const row of incoming) map.set(row.id, mergeIndexQuote(map.get(row.id), row));
  return INDEX_SPECS.map((spec) => map.get(spec.id)).filter((row): row is IndexQuote => Boolean(row));
}
