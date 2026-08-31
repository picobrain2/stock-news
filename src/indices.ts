import type { IndexQuote } from "./types";

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
}

export const INDEX_SPECS: IndexSpec[] = [
  { id: "kospi", name: "코스피", symbol: "^KS11", naver: { kind: "kr", code: "KOSPI" } },
  { id: "kosdaq", name: "코스닥", symbol: "^KQ11", naver: { kind: "kr", code: "KOSDAQ" } },
  { id: "nasdaq", name: "나스닥", symbol: "^IXIC", naver: { kind: "world", code: ".IXIC" } },
  { id: "spx", name: "S&P 500", symbol: "^GSPC", naver: { kind: "world", code: ".INX" } },
  { id: "nq", name: "나스닥 선물", symbol: "NQ=F" },
  { id: "es", name: "S&P 선물", symbol: "ES=F" },
  { id: "wti", name: "WTI 선물", symbol: "CL=F", naver: { kind: "oil", code: "OIL_CL" } },
  { id: "usdkrw", name: "원/달러", symbol: "KRW=X", naver: { kind: "fx", code: "FX_USDKRW" } },
];

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

function formatSparkDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function sparkTimeLabels(pointCount: number, now = Date.now()): { start: string; end: string } {
  if (pointCount < 2) return { start: "", end: "" };
  const end = new Date(now);
  const cursor = new Date(now);
  let trading = 0;
  while (trading < pointCount - 1) {
    cursor.setDate(cursor.getDate() - 1);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) trading += 1;
  }
  return { start: formatSparkDate(cursor), end: formatSparkDate(end) };
}

export interface SparkChart {
  line: string;
  area: string;
  width: number;
  height: number;
  labels: { start: string; end: string };
  min: number;
  max: number;
}

export function buildSparkChart(values: number[], width = 168, height = 46): SparkChart | null {
  const nums = downsample(values, 40);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const padY = 4;
  const innerH = height - padY * 2;
  const points = nums.map((v, i) => ({
    x: (i / (nums.length - 1)) * width,
    y: padY + innerH - ((v - min) / span) * innerH,
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${width.toFixed(1)} ${height} L0 ${height} Z`;
  return {
    line,
    area,
    width,
    height,
    labels: sparkTimeLabels(nums.length),
    min,
    max,
  };
}

export function mergeIndices(previous: IndexQuote[], incoming: IndexQuote[]): IndexQuote[] {
  const map = new Map<string, IndexQuote>();
  for (const row of previous) map.set(row.id, row);
  for (const row of incoming) map.set(row.id, row);
  return INDEX_SPECS.map((spec) => map.get(spec.id)).filter((row): row is IndexQuote => Boolean(row));
}
