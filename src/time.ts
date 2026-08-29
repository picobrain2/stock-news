const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

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
