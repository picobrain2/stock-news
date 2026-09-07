/**
 * Namuh (NHPLUG) REST — domestic quotes only.
 * Node-only helper for a future backend/Worker. Prefetch no longer pulls quotes;
 * live UI uses Naver/Yahoo in the browser. Never call from the browser (keys).
 * Do NOT add order/balance endpoints here.
 */
import type { Quote } from "./types";

const isBrowser = typeof window !== "undefined";

const SUCCESS_CODES = new Set(["00000", "00166", "00221", "13578"]);

function baseUrl(): string {
  if (isBrowser) return "";
  return (process.env.NHPLUG_BASE_URL ?? "https://api.nhplug.com:8443").replace(/\/$/, "");
}

function authUrl(): string {
  if (isBrowser) return "";
  return (process.env.NHPLUG_AUTH_URL ?? "https://api.nhplug.com:8443").replace(/\/$/, "");
}

type TokenCache = { token: string; exp: number };
let tokenCache: TokenCache | null = null;
let tokenInflight: Promise<string | null> | null = null;

let lastCallAt = 0;
const MIN_GAP_MS = 260; // ~4 calls/sec (NH limit ~5/s)
let throttleChain: Promise<void> = Promise.resolve();

export type NamuhStats = { ok: number; fail: number };
export const namuhStats: NamuhStats = { ok: 0, fail: 0 };

function appKey(): string {
  return (process.env.NHPLUG_APP_KEY ?? process.env.APP_KEY ?? "").trim();
}

function appSecret(): string {
  return (process.env.NHPLUG_APP_SECRET ?? process.env.APP_SECRET ?? "").trim();
}

export function namuhEnabled(): boolean {
  return !isBrowser && Boolean(appKey() && appSecret());
}

export function resetNamuhStats(): void {
  namuhStats.ok = 0;
  namuhStats.fail = 0;
}

function iemCd(symbol: string): string | null {
  const root = symbol.replace(/\.(KS|KQ)$/i, "");
  return /^\d{6}$/.test(root) ? root : null;
}

function isSuccess(rspCd: unknown, rspMsg: unknown): boolean {
  if (rspCd == null) return true;
  if (SUCCESS_CODES.has(String(rspCd))) return true;
  return typeof rspMsg === "string" && rspMsg.includes("완료");
}

async function throttle(): Promise<void> {
  const run = throttleChain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  throttleChain = run.catch(() => undefined);
  await run;
}

async function getToken(force = false): Promise<string | null> {
  const key = appKey();
  const secret = appSecret();
  if (!key || !secret) return null;
  const now = Date.now() / 1000;
  if (!force && tokenCache && tokenCache.exp > now + 30) return tokenCache.token;
  if (!force && tokenInflight) return tokenInflight;

  const job = (async (): Promise<string | null> => {
    const url = new URL(`${authUrl()}/oauth2/token`);
    url.searchParams.set("appkey", key);
    url.searchParams.set("appsecretkey", secret);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("scope", "oob");

    try {
      await throttle();
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        console.warn(`namuh token ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        console.warn("namuh token missing access_token");
        return null;
      }
      const issuedAt = Date.now() / 1000;
      tokenCache = {
        token: data.access_token,
        exp: issuedAt + Number(data.expires_in ?? 86_400),
      };
      return tokenCache.token;
    } catch (err) {
      console.warn("namuh token failed", err instanceof Error ? err.message : err);
      return null;
    } finally {
      tokenInflight = null;
    }
  })();

  tokenInflight = job;
  return job;
}

type CurrentPriceOut = {
  iem_cd?: string;
  iem_nm?: string;
  stck_prpr?: number | string;
  prdy_ctrt?: number | string;
  prdy_vrss?: number | string;
};

async function callCurrentPrice(code: string): Promise<CurrentPriceOut | null> {
  let token = await getToken(false);
  if (!token) return null;

  const url = `${baseUrl()}/krstock/quote/v1/currentPrice`;
  const body = JSON.stringify({ Input_0: { iem_cd: code, market_cd: "KRX" } });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await throttle();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-client-id": appKey(),
          "x-client-secret": appSecret(),
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=UTF-8",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if ((res.status === 401 || /IGW40043|유효하지\s*않은\s*token/i.test(text)) && attempt === 0) {
        tokenCache = null;
        token = await getToken(true);
        if (!token) return null;
        continue;
      }
      if (!res.ok) {
        console.warn(`namuh currentPrice ${code} HTTP ${res.status}`);
        return null;
      }
      const data = JSON.parse(text) as {
        rsp_cd?: string;
        rsp_msg?: string;
        Output_0?: CurrentPriceOut;
      };
      if (!isSuccess(data.rsp_cd, data.rsp_msg)) {
        console.warn(`namuh currentPrice ${code} rsp_cd=${data.rsp_cd}`);
        return null;
      }
      return data.Output_0 ?? null;
    } catch (err) {
      console.warn(`namuh currentPrice ${code} failed`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

function num(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return NaN;
  return Number(String(raw).replace(/,/g, ""));
}

/** Prefetch/Node only. Returns null when disabled or on failure. */
export async function namuhQuote(symbol: string): Promise<Quote | null> {
  if (!namuhEnabled()) return null;
  const code = iemCd(symbol);
  if (!code) return null;
  const out = await callCurrentPrice(code);
  if (!out) {
    namuhStats.fail += 1;
    return null;
  }
  const price = num(out.stck_prpr);
  if (!Number.isFinite(price) || price <= 0) {
    namuhStats.fail += 1;
    return null;
  }
  const changePct = num(out.prdy_ctrt);
  namuhStats.ok += 1;
  return {
    symbol,
    price,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    currency: "KRW",
    name: (out.iem_nm ?? "").trim() || symbol,
  };
}
