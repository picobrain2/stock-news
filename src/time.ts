import type { ReviewRange } from "./types";

const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

export function rangeWindow(range: ReviewRange): { from: number; to: number; maxAgeMs: number } {
  const to = Date.now();
  const days = range === "week" ? 7 : range === "month" ? 30 : 365;
  const maxAgeMs = days * 86_400_000;
  return { from: to - maxAgeMs, to, maxAgeMs };
}

export function parseNewsDate(raw: string, now = Date.now()): number {
  const s = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return 0;
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return clampNewsDate(direct, now);
  const kr = s.match(
    /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?)?/,
  );
  if (kr) {
    return clampNewsDate(new Date(
      Number(kr[1]),
      Number(kr[2]) - 1,
      Number(kr[3]),
      Number(kr[4] ?? 0),
      Number(kr[5] ?? 0),
    ).getTime(), now);
  }
  const dotted = s.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dotted) {
    const iso = `${dotted[1]}-${dotted[2].padStart(2, "0")}-${dotted[3].padStart(2, "0")}T${(dotted[4] ?? "00").padStart(2, "0")}:${dotted[5] ?? "00"}:${dotted[6] ?? "00"}+09:00`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return clampNewsDate(t, now);
  }
  if (/^\d{10}$/.test(s)) return clampNewsDate(Number(s) * 1000, now);
  if (/^\d{13}$/.test(s)) return clampNewsDate(Number(s), now);
  return 0;
}

function clampNewsDate(ts: number, now: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (ts > now + 2 * 3_600_000) return 0;
  return ts;
}

export function pickPublishedAt(a: number, b: number): number {
  const left = a > 0 ? a : 0;
  const right = b > 0 ? b : 0;
  if (left && right) return Math.min(left, right);
  return left || right;
}

export function fromNow(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const min = Math.round(diff / 60_000);
  const hour = Math.round(diff / 3_600_000);
  const day = Math.round(diff / 86_400_000);
  if (Math.abs(min) < 1) return "방금";
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  if (Math.abs(hour) < 24) return rtf.format(hour, "hour");
  if (Math.abs(day) < 7) return rtf.format(day, "day");
  return new Date(ts).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isFresh(ts: number, now = Date.now()): boolean {
  return now - ts < 20 * 60_000;
}

export function formatPrice(price: number, currency: string): string {
  const krw = currency === "KRW";
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: krw ? 0 : 2,
    maximumFractionDigits: krw ? 0 : 2,
  }).format(price);
}

export function formatIndexPrice(price: number): string {
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

export function formatDay(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", weekday: "short" });
}

export function formatRange(from: number, to: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };
  return `${new Date(from).toLocaleDateString("ko-KR", opts)} – ${new Date(to).toLocaleDateString("ko-KR", opts)}`;
}

export function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function marketStatus(now = new Date()): { kr: string; us: string } {
  const krOpen = isOpen(now, 9, 0, 15, 30, 9);
  const usNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const usOpen = isWeekday(usNow) && inMinutes(usNow, 9, 30, 16, 0);
  return {
    kr: krOpen ? "한국 개장" : "한국 휴장",
    us: usOpen ? "미국 개장" : "미국 휴장",
  };
}

function isOpen(now: Date, h1: number, m1: number, h2: number, m2: number, offsetHours: number): boolean {
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const local = new Date(utc + offsetHours * 3_600_000);
  return isWeekday(local) && inMinutes(local, h1, m1, h2, m2);
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function inMinutes(d: Date, h1: number, m1: number, h2: number, m2: number): boolean {
  const n = d.getHours() * 60 + d.getMinutes();
  return n >= h1 * 60 + m1 && n <= h2 * 60 + m2;
}
