import type { Stock, StockDetail, StockStat } from "./types";

type NaverBasic = {
  stockName?: string;
  closePrice?: string;
  fluctuationsRatio?: string;
  compareToPreviousClosePrice?: string;
  stockExchangeName?: string;
  currencyType?: { code?: string };
};

type NaverInfo = { key?: string; value?: string; code?: string };

type NaverIntegration = {
  totalInfos?: NaverInfo[];
  consensusInfo?: {
    priceTargetMean?: string;
    recommMean?: string;
  };
};

const STAT_ORDER = [
  "marketValue",
  "accumulatedTradingVolume",
  "accumulatedTradingValue",
  "per",
  "pbr",
  "dividendYieldRatio",
  "foreignRate",
  "highPriceOf52Weeks",
  "lowPriceOf52Weeks",
  "openPrice",
  "highPrice",
  "lowPrice",
];

function num(raw: string | undefined): number {
  const n = Number(String(raw ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function naverCode(stock: Stock): { code: string; kr: boolean } {
  if (stock.market === "kr" || /^\d{6}$/.test(stock.id)) {
    const code = stock.id.replace(/\.(KS|KQ)$/i, "").slice(0, 6);
    return { code, kr: true };
  }
  const root = (stock.yahoo || stock.id).replace(/\.(KS|KQ)$/i, "");
  const code = /\.[A-Z]+$/i.test(root) ? root : `${root}.O`;
  return { code, kr: false };
}

function naverPageUrl(code: string, kr: boolean): string {
  if (kr) return `https://m.stock.naver.com/domestic/stock/${code}/total`;
  return `https://m.stock.naver.com/worldstock/stock/${code}/total`;
}

function pickStats(rows: NaverInfo[]): StockStat[] {
  const map = new Map<string, StockStat>();
  for (const row of rows) {
    if (!row.key || !row.value) continue;
    map.set(row.code ?? row.key, { label: row.key, value: row.value });
  }
  const ordered = STAT_ORDER.flatMap((code) => {
    const hit = map.get(code);
    return hit ? [hit] : [];
  });
  const seen = new Set(ordered.map((row) => row.label));
  return [...ordered, ...[...map.values()].filter((row) => !seen.has(row.label))].slice(0, 10);
}

export async function getStockDetail(
  stock: Stock,
  fetchText: (url: string, timeoutMs?: number) => Promise<string>,
): Promise<StockDetail | null> {
  const { code, kr } = naverCode(stock);
  const basicUrl = kr
    ? `https://m.stock.naver.com/api/stock/${code}/basic`
    : `https://api.stock.naver.com/stock/${code}/basic`;
  const integUrl = kr
    ? `https://m.stock.naver.com/api/stock/${code}/integration`
    : `https://api.stock.naver.com/stock/${code}/integration`;

  let basicRaw = "";
  try {
    basicRaw = await fetchText(basicUrl, 5500);
  } catch {
    return null;
  }
  let basic: NaverBasic;
  try {
    basic = JSON.parse(basicRaw) as NaverBasic;
  } catch {
    return null;
  }
  const price = num(basic.closePrice);
  if (!Number.isFinite(price)) return null;

  let integration: NaverIntegration = {};
  try {
    integration = JSON.parse(await fetchText(integUrl, 5500)) as NaverIntegration;
  } catch {
    /* basic only */
  }

  const currency = basic.currencyType?.code ?? (kr ? "KRW" : "USD");
  const stats = pickStats(integration.totalInfos ?? []);
  const consensus = integration.consensusInfo;
  const target = consensus?.priceTargetMean
    ? (kr ? `${Number(consensus.priceTargetMean).toLocaleString("ko-KR")}원` : `$${consensus.priceTargetMean}`)
    : undefined;

  return {
    id: stock.id,
    name: basic.stockName || stock.name,
    price,
    changePct: num(basic.fluctuationsRatio) || 0,
    change: basic.compareToPreviousClosePrice,
    currency,
    exchange: basic.stockExchangeName ?? (kr ? "KOSPI" : "NASDAQ"),
    stats,
    targetPrice: target,
    recommend: consensus?.recommMean,
    naverUrl: naverPageUrl(code, kr),
  };
}
