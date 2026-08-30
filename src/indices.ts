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
  const nums = downsample(values, 56);
  if (nums.length < 2) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  return nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * width;
      const y = height - ((v - min) / span) * (height - 6) - 3;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export function mergeIndices(previous: IndexQuote[], incoming: IndexQuote[]): IndexQuote[] {
  const map = new Map<string, IndexQuote>();
  for (const row of previous) map.set(row.id, row);
  for (const row of incoming) map.set(row.id, row);
  return INDEX_SPECS.map((spec) => map.get(spec.id)).filter((row): row is IndexQuote => Boolean(row));
}
