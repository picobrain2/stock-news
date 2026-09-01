import { classifyTone } from "./impact";
import { bundledMarket, bundledIndices, bundledPulls, bundledQuotes, bundledReview, bundledStockDetail, bundledStocks, bundleFetchedAt, fetchIndices, fetchMarket, fetchQuoteQuick, fetchQuotes, fetchReview, fetchStockDetail, fetchStockNews, lastPulls, loadDetailCache, searchRemote } from "./api";
import { detailFromQuote, mergeStockDetail } from "./naverStock";
import { INDEX_REFRESH_MS } from "./feeds";
import { loadArchive, saveArchive } from "./archive";
import { findStock, popularStocks, searchCatalog, typedStock } from "./catalog";
import { buildSparkChart, indexSession } from "./indices";
import { formatDay, formatIndexPrice, formatPct, formatPrice, formatRange, fromNow, isFresh, marketStatus } from "./time";
import { cleanSnippet } from "./text";
import type { IndexQuote, NewsItem, Quote, ReviewBundle, ReviewRange, SearchHit, Stock, StockDetail, Tab } from "./types";
import { loadWatchlist, saveWatchlist } from "./watchlist";

const app = document.querySelector<HTMLDivElement>("#app")!;
const boot = loadArchive();

let tab: Tab = "market";
let watchlist = loadWatchlist();
let quotes = new Map(
  (boot.quotes.length ? boot.quotes : bundledQuotes())
    .filter((q) => q.price > 0)
    .map((q) => [q.symbol, q]),
);
let marketNews: NewsItem[] = boot.market.length ? boot.market : bundledMarket();
let stockNews: NewsItem[] = boot.stocks.length ? boot.stocks : bundledStocks();
let filterId = "all";
let regionFilter: "all" | "kr" | "us" = "all";
let search = "";
let suggestions: SearchHit[] = [];
let loadingMarket = marketNews.length === 0;
let loadingMine = stockNews.length === 0;
let error = "";
let lastFetch = boot.fetchedAt;
let sourcePulls = boot.pulls?.length ? boot.pulls : bundledPulls();
let reviewRange: ReviewRange = "week";
let reviewBundle: ReviewBundle = bundledReview();
let loadingReview = !reviewBundle.week;
let searchTimer = 0;
let indices: IndexQuote[] = boot.indices?.length ? boot.indices : bundledIndices();
let loadingIndices = indices.length === 0;
type MobilePane = "news" | "watch";
let mobilePane: MobilePane = "news";
let stockDetail: StockDetail | null = null;
let stockDetailFor = "";
let loadingStockDetail = false;
let stockDetailGen = 0;
const stickyQuotes = new Map<string, Quote>();
const stickyIndexSpark = new Map<string, Pick<IndexQuote, "spark" | "sparkAt" | "sparkTz">>();
const stickyDetails = new Map<string, StockDetail>();
let quotesRefresh: Promise<void> | null = null;
let batchingRefresh = 0;
let paintRaf = 0;
let indicesPoll: Promise<void> | null = null;
let boardSignature = "";
const indexCardCache = new Map<string, { key: string; html: string }>();
const FEED_RENDER_CAP = 80;

function indexRowForCard(row: IndexQuote): IndexQuote {
  const sticky = stickyIndexSpark.get(row.id);
  if (!sticky) return row;
  const hasLive = row.spark.length >= 3 && (row.sparkAt?.length ?? 0) >= 3;
  if (hasLive) return row;
  if ((sticky.spark?.length ?? 0) >= (row.spark?.length ?? 0)) return { ...row, ...sticky };
  return row;
}

function rememberStockDetail(stock: Stock, incoming: StockDetail): StockDetail {
  const prev = stickyDetails.get(stock.id);
  const row = prev ? mergeStockDetail(prev, incoming) : incoming;
  stickyDetails.set(stock.id, row);
  return row;
}

function detailFor(stock: Stock): StockDetail | undefined {
  return stickyDetails.get(stock.id);
}

function showNewsPane(): void {
  mobilePane = "news";
}

function selectStock(id: string): void {
  if (filterId !== id) {
    stockDetail = null;
    stockDetailFor = "";
    loadingStockDetail = false;
    stockDetailGen += 1;
  }
  filterId = id;
  tab = "mine";
  showNewsPane();
  void refreshStockDetail();
  paint();
}

function clearStockFilter(): void {
  filterId = "all";
  stockDetail = null;
  stockDetailFor = "";
  loadingStockDetail = false;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch
  ));
}

function stockById(id: string): Stock | undefined {
  return watchlist.find((s) => s.id === id) ?? findStock(id);
}

function storeQuote(stock: Stock, q: Quote): void {
  if (q.price <= 0) return;
  const row: Quote = { ...q, symbol: stock.yahoo, name: q.name || stock.name };
  quotes.set(stock.yahoo, row);
  stickyQuotes.set(stock.yahoo, row);
}

function quoteFor(stock: Stock): Quote | undefined {
  const q = quotes.get(stock.yahoo)
    ?? quotes.get(stock.yahoo.toUpperCase())
    ?? quotes.get(stock.id)
    ?? quotes.get(`${stock.id}.KS`)
    ?? quotes.get(`${stock.id}.KQ`)
    ?? stickyQuotes.get(stock.yahoo)
    ?? stickyQuotes.get(stock.id);
  return q && q.price > 0 ? q : undefined;
}

function rememberQuotes(rows: Quote[]): void {
  for (const q of rows) {
    if (q.price <= 0) continue;
    quotes.set(q.symbol, q);
    stickyQuotes.set(q.symbol, q);
    const stock = watchlist.find((s) => s.yahoo === q.symbol || s.id === q.symbol);
    if (stock && stock.yahoo !== q.symbol) {
      quotes.set(stock.yahoo, { ...q, symbol: stock.yahoo });
      stickyQuotes.set(stock.yahoo, { ...q, symbol: stock.yahoo });
    }
  }
}

function seedQuote(stock: Stock, hit: SearchHit | Stock): void {
  if (!("price" in hit) || hit.price == null || !Number.isFinite(hit.price) || hit.price <= 0) return;
  storeQuote(stock, {
    symbol: stock.yahoo,
    price: hit.price,
    changePct: hit.changePct ?? 0,
    currency: hit.currency ?? (stock.market === "kr" ? "KRW" : "USD"),
    name: stock.name,
  });
}

function visibleNews(): NewsItem[] {
  const source = tab === "market" ? marketNews : stockNews;
  return source.filter((item) => {
    if (regionFilter !== "all" && item.region !== regionFilter && item.region !== "global") return false;
    if (tab === "mine" && filterId !== "all" && !item.stockIds.includes(filterId)) return false;
    return true;
  });
}

function splitFeed(items: NewsItem[]): { spotlight: NewsItem[]; rest: NewsItem[] } {
  const now = Date.now();
  const spotlight = items.filter((n) => n.impact >= 24 && now - n.publishedAt < 12 * 3_600_000);
  const ids = new Set(spotlight.map((n) => n.id));
  const rest = items.filter((n) => !ids.has(n.id));
  const room = Math.max(0, FEED_RENDER_CAP - spotlight.length);
  return { spotlight, rest: rest.slice(0, room) };
}

function addStock(hit: SearchHit | Stock): void {
  if (watchlist.some((s) => s.id === hit.id || s.yahoo === hit.yahoo)) return;
  const known = findStock(hit.id);
  const stock: Stock = known ?? {
    id: hit.id,
    name: hit.name,
    nameEn: hit.nameEn || hit.name,
    aliases: [],
    yahoo: hit.yahoo,
    market: hit.market,
    popular: false,
  };
  watchlist = [stock, ...watchlist].slice(0, 16);
  saveWatchlist(watchlist);
  seedQuote(stock, hit);
  search = "";
  suggestions = [];
  tab = "mine";
  stockDetail = null;
  stockDetailFor = "";
  stockDetailGen += 1;
  filterId = stock.id;
  showNewsPane();
  void refreshMine();
  void refreshStockDetail();
  void refreshQuotes().then(() => persist());
  paint();
}

function removeStock(id: string): void {
  watchlist = watchlist.filter((s) => s.id !== id);
  saveWatchlist(watchlist);
  if (filterId === id) clearStockFilter();
  void refreshMine();
  paint();
}

async function persist(): Promise<void> {
  saveArchive({
    market: marketNews,
    stocks: stockNews,
    quotes: [...quotes.values()],
    indices,
    pulls: sourcePulls,
    fetchedAt: bundleFetchedAt || lastFetch || Date.now(),
  });
}

async function refreshAll(): Promise<void> {
  batchingRefresh += 1;
  try {
    error = "";
    await Promise.all([
      refreshMarket(),
      refreshMine(),
      refreshQuotes({ live: false }),
      refreshIndices({ live: false }),
      refreshReview(),
    ]);
    lastFetch = bundleFetchedAt || Date.now();
    if (lastPulls.length) sourcePulls = lastPulls;
    await persist();
  } finally {
    batchingRefresh -= 1;
    paintImmediate();
  }
  void refreshLiveTail();
}

async function refreshLiveTail(): Promise<void> {
  await Promise.all([
    refreshQuotes({ live: true }),
    refreshIndices({ live: true }),
  ]);
  if (hasShell()) updateIndexBoard();
}

async function refreshReview(): Promise<void> {
  loadingReview = true;
  paint();
  try {
    reviewBundle = await fetchReview();
  } catch {
    /* bundled review stays */
  } finally {
    loadingReview = false;
    paint();
  }
}

function reviewPane(): string {
  const packed = reviewBundle[reviewRange];
  const label = reviewRange === "week" ? "지난 일주일" : reviewRange === "month" ? "지난 한 달" : "지난 1년";
  if (loadingReview && !packed) return skeleton();
  if (!packed || (packed.timeline.length === 0 && packed.themes.length === 0)) {
    return `<div class="empty">${esc(label)} 정리를 아직 못 모았습니다. 약 10분마다 다시 만듭니다.</div>`;
  }
  const toneClass = (tone: string) => (tone === "up" ? "up" : tone === "down" ? "down" : "mixed");
  return `
    <p class="lead">${esc(label)} (${esc(formatRange(packed.from, packed.to))}) 경제 흐름과 주요 사건을 모아 두었습니다.</p>
    <section class="review-hero">
      <h2>흐름</h2>
      <p>${esc(packed.headline)}</p>
    </section>
    ${packed.themes.length ? `
      <h2 class="feed-label">주제별 정리</h2>
      <div class="themes">${packed.themes.map((theme) => `
        <article class="theme">
          <div class="theme-head">
            <strong>${esc(theme.tag)}</strong>
            <span class="tone ${toneClass(theme.tone)}">${theme.tone === "up" ? "호재" : theme.tone === "down" ? "악재" : "혼조"}</span>
            <span class="muted">${theme.count}건</span>
          </div>
          <p>${esc(theme.summary)}</p>
          <ul>${theme.events.map((ev) => `
            <li><a href="${esc(ev.url)}" target="_blank" rel="noopener noreferrer">${esc(ev.title)}</a></li>
          `).join("")}</ul>
        </article>
      `).join("")}</div>
    ` : ""}
    ${packed.timeline.length ? `
      <h2 class="feed-label">주요 사건</h2>
      <ol class="timeline">${packed.timeline.map((ev) => `
        <li>
          <a class="card" href="${esc(ev.url)}" target="_blank" rel="noopener noreferrer">
            <div class="card-meta">
              <span class="when">${ev.publishedAt ? esc(formatDay(ev.publishedAt)) : ""}</span>
              <span class="dot">·</span>
              <span class="src">${esc(ev.source)}</span>
              ${ev.tags.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
            </div>
            <h3>${esc(ev.title)}</h3>
            ${ev.snippet ? `<p class="summary">${esc(ev.snippet)}</p>` : ""}
          </a>
        </li>
      `).join("")}</ol>
    ` : ""}
  `;
}

function sourcePullsHTML(): string {
  if (sourcePulls.length === 0) return "";
  const rows = [...sourcePulls].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return b.fetchedAt - a.fetchedAt;
  });
  return `<div class="pulls" aria-label="신문사별 수집 시각">${rows.map((pull) => `
    <span class="pull${pull.ok ? "" : " bad"}">
      <strong>${esc(pull.source)}</strong>
      ${pull.ok ? `${esc(fromNow(pull.fetchedAt))} · ${pull.count}건` : "가져오기 실패"}
    </span>
  `).join("")}</div>`;
}

async function refreshMarket(): Promise<void> {
  loadingMarket = true;
  paint();
  try {
    marketNews = await fetchMarket(marketNews);
    if (lastPulls.length) sourcePulls = lastPulls;
  } catch (err) {
    error = err instanceof Error ? err.message : "뉴스를 불러오지 못했습니다.";
  } finally {
    loadingMarket = false;
    paint();
  }
}

async function refreshMine(): Promise<void> {
  if (watchlist.length === 0) {
    stockNews = [];
    loadingMine = false;
    paint();
    return;
  }
  loadingMine = true;
  paint();
  try {
    stockNews = await fetchStockNews(watchlist, stockNews);
  } catch (err) {
    error = err instanceof Error ? err.message : "종목 뉴스를 불러오지 못했습니다.";
  } finally {
    loadingMine = false;
    paint();
  }
}

async function refreshQuotes(opts?: { live?: boolean }): Promise<void> {
  if (quotesRefresh) return quotesRefresh;
  quotesRefresh = refreshQuotesInner(Boolean(opts?.live)).finally(() => {
    quotesRefresh = null;
  });
  return quotesRefresh;
}

async function refreshQuotesInner(live = true): Promise<void> {
  try {
    const snap = () => [...quotes.values(), ...stickyQuotes.values()];
    rememberQuotes(await fetchQuotes(watchlist, snap(), false));
    if (!live) return;
    paint();
    if (watchlist.every((s) => quoteFor(s))) return;
    rememberQuotes(await fetchQuotes(watchlist, snap(), true));
    paint();
  } catch {
    /* quotes are optional */
  }
}

function shouldPollIndices(): boolean {
  return (tab === "market" || tab === "mine") && document.visibilityState === "visible";
}

function rememberIndexSpark(rows: IndexQuote[]): void {
  for (const row of rows) {
    if (row.spark.length < 2) continue;
    stickyIndexSpark.set(row.id, {
      spark: row.spark,
      sparkAt: row.sparkAt,
      sparkTz: row.sparkTz,
    });
  }
}

function indicesSignature(rows: IndexQuote[]): string {
  return rows.map((row) => `${row.id}:${row.price}:${row.changePct}:${row.spark.length}:${row.sparkAt?.at(-1) ?? 0}`).join("|");
}

async function refreshIndices(opts?: { live?: boolean }): Promise<void> {
  if (indicesPoll) return indicesPoll;
  indicesPoll = refreshIndicesInner(Boolean(opts?.live)).finally(() => {
    indicesPoll = null;
  });
  return indicesPoll;
}

async function refreshIndicesInner(live = false): Promise<void> {
  try {
    if (!indices.length) {
      indices = await fetchIndices([], false);
      rememberIndexSpark(indices);
      paint();
    }
    indices = await fetchIndices(indices, live);
    rememberIndexSpark(indices);
  } catch {
    /* indices are optional */
  } finally {
    loadingIndices = false;
    if (hasShell()) updateIndexBoard();
    else paint();
  }
}

async function refreshStockDetail(): Promise<void> {
  if (filterId === "all") {
    stockDetail = null;
    stockDetailFor = "";
    loadingStockDetail = false;
    return;
  }
  const stock = stockById(filterId);
  if (!stock) return;
  if (stockDetailFor === stock.id && stockDetail && !loadingStockDetail) return;

  const gen = ++stockDetailGen;
  const seeded = bundledStockDetail(stock.id);
  if (seeded) {
    stockDetail = rememberStockDetail(stock, seeded);
    stockDetailFor = stock.id;
  } else {
    void loadDetailCache(stock.id).then((fileSeed) => {
      if (!fileSeed || gen !== stockDetailGen || filterId !== stock.id) return;
      stockDetail = rememberStockDetail(stock, fileSeed);
      stockDetailFor = stock.id;
      paint();
    });
  }
  loadingStockDetail = true;
  paint();
  if (!seeded && !quoteFor(stock)) {
    void fetchQuoteQuick(stock).then((q) => {
      if (!q || gen !== stockDetailGen || filterId !== stock.id) return;
      storeQuote(stock, q);
      if (stockDetailFor !== stock.id || !stockDetail?.stats.length) {
        const next = detailFromQuote(stock, q);
        stockDetail = rememberStockDetail(stock, next);
        stockDetailFor = stock.id;
        paint();
      }
    });
  }
  try {
    const detail = await fetchStockDetail(stock);
    if (gen !== stockDetailGen || filterId !== stock.id) return;
    if (detail && detail.price > 0) {
      stockDetail = rememberStockDetail(stock, detail);
      stockDetailFor = stock.id;
      storeQuote(stock, {
        symbol: stock.yahoo,
        price: detail.price,
        changePct: detail.changePct,
        currency: detail.currency,
        name: detail.name,
      });
    }
  } catch {
    if (gen !== stockDetailGen || filterId !== stock.id) return;
    if (!stockDetail) {
      stockDetailFor = "";
    }
  } finally {
    if (gen !== stockDetailGen) return;
    loadingStockDetail = false;
    paint();
  }
}

async function onSearchInput(value: string): Promise<void> {
  search = value;
  window.clearTimeout(searchTimer);
  const local = searchCatalog(value);
  const typed = typedStock(value);
  suggestions = [
    ...(typed ? [typed] : []),
    ...local,
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i).slice(0, 8);
  paint();
  if (value.trim().length < 2) return;
  searchTimer = window.setTimeout(async () => {
    try {
      const remote = await searchRemote(value);
      const seen = new Set(suggestions.map((s) => s.id));
      for (const hit of remote) {
        if (!seen.has(hit.id)) {
          suggestions.push(hit);
          seen.add(hit.id);
        }
      }
      suggestions = suggestions.slice(0, 10);
      paint();
    } catch {
      /* local results are enough */
    }
  }, 220);
}

function newsCard(item: NewsItem): string {
  const stocks = item.stockIds
    .map(stockById)
    .filter((s): s is Stock => Boolean(s))
    .slice(0, 3);
  const focus = tab === "mine" && filterId !== "all"
    ? stocks.filter((s) => s.id === filterId)
    : stocks;
  const names = focus.flatMap((s) => [s.name, s.nameEn, s.id, ...s.aliases]);
  const call = names.length || tab === "mine"
    ? classifyTone(item.title, item.snippet, names)
    : classifyTone(item.title, item.snippet);
  const toneLabel = tab === "mine" && filterId !== "all" && focus[0]
    ? `${focus[0].name} ${call.label}`
    : call.label;
  const fresh = isFresh(item.publishedAt) ? " fresh" : "";
  const impact = item.impact >= 28 ? "high" : item.impact >= 16 ? "mid" : "";
  const showTone = tab === "mine" || call.tone !== "mixed";
  const snippet = cleanSnippet(item.snippet, item.title);
  return `
    <a class="card${fresh} tone-${call.tone}" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">
      <div class="card-meta">
        ${showTone ? `<span class="tone ${call.tone}">${esc(toneLabel)}</span>` : ""}
        <span class="when">${item.publishedAt > 0 ? esc(fromNow(item.publishedAt)) : "시간 미상"}</span>
        <span class="dot">·</span>
        <span class="src">${esc(item.source)}</span>
        <span class="region">${item.region === "kr" ? "한국" : item.region === "us" ? "미국" : "글로벌"}</span>
        ${impact ? `<span class="impact ${impact}">영향 ${impact === "high" ? "큼" : "있음"}</span>` : ""}
      </div>
      <h3>${esc(item.title)}</h3>
      ${item.titleEn && item.titleEn !== item.title ? `<p class="orig">${esc(item.titleEn)}</p>` : ""}
      ${snippet ? `<p class="summary">${esc(snippet)}</p>` : ""}
      <div class="card-tags">
        ${item.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${stocks.map((s) => `<span class="tag stock">${esc(s.name)}</span>`).join("")}
      </div>
    </a>
  `;
}

function watchRow(stock: Stock): string {
  const q = quoteFor(stock);
  const active = tab === "mine" && filterId === stock.id ? " active" : "";
  return `
    <div class="watch${active}" data-open="${esc(stock.id)}">
      <div class="watch-main">
        <div class="watch-name">${esc(stock.name)}</div>
        <div class="watch-id">${esc(stock.id)} · ${stock.market === "kr" ? "한국" : "미국"}</div>
      </div>
      <div class="watch-px">
        ${q ? `
          <div class="px">${esc(formatPrice(q.price, q.currency))}</div>
          <div class="${q.changePct > 0 ? "up" : q.changePct < 0 ? "down" : "muted"}">${esc(formatPct(q.changePct))}</div>
        ` : `<div class="muted">시세 대기</div>`}
      </div>
      <button class="icon-btn" data-remove="${esc(stock.id)}" title="빼기" aria-label="${esc(stock.name)} 빼기">×</button>
    </div>
  `;
}

function stockDetailPanel(): string {
  const stock = stockById(filterId);
  if (!stock) return "";
  const matched = stockDetailFor === filterId ? stockDetail : null;
  const sticky = detailFor(stock);
  const q: StockDetail | null = (() => {
    const base = matched ?? (() => {
      const hit = quoteFor(stock);
      if (!hit) return null;
      return detailFromQuote(stock, hit);
    })();
    if (!base) return sticky ?? null;
    return sticky ? mergeStockDetail(sticky, base) : base;
  })();
  if (!q || q.price <= 0) {
    if (loadingStockDetail) {
      return `<section class="stock-hero sk"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w70"></div></section>`;
    }
    return "";
  }
  const pending = loadingStockDetail && !matched?.stats.length;
  const tone = q.changePct > 0 ? "up" : q.changePct < 0 ? "down" : "muted";
  const change = q.change ? ` (${q.change})` : "";
  return `
    <section class="stock-hero${pending ? " pending" : ""}">
      <div class="stock-hero-head">
        <div>
          <h2>${esc(q.name)}</h2>
          <div class="muted">${esc(stock.id)} · ${esc(q.exchange)}</div>
        </div>
        ${q.naverUrl ? `<a class="ghost stock-link" href="${esc(q.naverUrl)}" target="_blank" rel="noopener noreferrer">네이버증권</a>` : ""}
      </div>
      <div class="stock-hero-px">
        <span class="px-big">${esc(formatPrice(q.price, q.currency))}</span>
        <span class="${tone}">${esc(formatPct(q.changePct))}${esc(change)}</span>
      </div>
      ${pending ? `<p class="stock-pending muted">지표 불러오는 중…</p>` : ""}
      ${q.targetPrice ? `<div class="stock-target">목표가 <strong>${esc(q.targetPrice)}</strong>${q.recommend ? ` · 컨센서스 ${esc(q.recommend)}` : ""}</div>` : ""}
      ${q.stats.length ? `
        <div class="stock-stats">
          ${q.stats.map((row) => `
            <div class="stat">
              <span>${esc(row.label)}</span>
              <strong>${esc(row.value)}</strong>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function indexCard(row: IndexQuote): string {
  const session = indexSession(row.id);
  let cardRow = indexRowForCard(row);
  const cacheKey = `${cardRow.price}|${cardRow.changePct}|${cardRow.spark.length}|${cardRow.sparkAt?.at(-1) ?? 0}`;
  const cached = indexCardCache.get(row.id);
  if (cached?.key === cacheKey) return cached.html;

  let chart = buildSparkChart(cardRow.spark, 180, 58, cardRow.sparkAt, session);
  if (!chart) {
    const sticky = stickyIndexSpark.get(row.id);
    if (sticky) {
      cardRow = { ...row, ...sticky };
      chart = buildSparkChart(cardRow.spark, 180, 58, cardRow.sparkAt, session);
    }
  }
  if (chart && cardRow.spark.length >= 2) {
    stickyIndexSpark.set(row.id, {
      spark: cardRow.spark,
      sparkAt: cardRow.sparkAt,
      sparkTz: cardRow.sparkTz,
    });
  }
  const tone = row.changePct > 0 ? "up" : row.changePct < 0 ? "down" : "flat";
  const color = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--muted)";
  const gradId = `spark-${row.id}`;
  const chartBlock = chart ? `
    <div class="index-chart">
      <svg class="spark" viewBox="0 0 ${chart.width} ${chart.height}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.32"></stop>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <line class="spark-grid" x1="0" y1="${(chart.height * 0.33).toFixed(1)}" x2="${chart.width}" y2="${(chart.height * 0.33).toFixed(1)}"></line>
        <line class="spark-grid" x1="0" y1="${(chart.height * 0.66).toFixed(1)}" x2="${chart.width}" y2="${(chart.height * 0.66).toFixed(1)}"></line>
        <path class="spark-area" d="${chart.area}" fill="url(#${gradId})"></path>
        <path class="spark-line" d="${chart.line}" fill="none" stroke="${color}" stroke-width="2.2" vector-effect="non-scaling-stroke"></path>
        <circle class="spark-dot-halo" cx="${chart.lastX.toFixed(1)}" cy="${chart.lastY.toFixed(1)}" r="6" fill="${color}" opacity="0.18"></circle>
        <circle class="spark-dot" cx="${chart.lastX.toFixed(1)}" cy="${chart.lastY.toFixed(1)}" r="3" fill="${color}"></circle>
      </svg>
      <div class="spark-axis">
        <span class="spark-date">${esc(chart.labels.start)}</span>
        <span class="spark-range">${esc(formatIndexPrice(chart.min))} – ${esc(formatIndexPrice(chart.max))}</span>
        <span class="spark-date end">${esc(chart.labels.end)}</span>
      </div>
    </div>
  ` : `<div class="spark-gap spark-pending"><span class="muted">차트 불러오는 중</span></div>`;
  const html = `
    <article class="index tone-${tone}">
      <div class="index-top">
        <div class="index-name">${esc(row.name)}</div>
        <div class="index-chg ${tone === "flat" ? "muted" : tone}">${esc(formatPct(row.changePct))}</div>
      </div>
      <div class="index-px">${esc(formatIndexPrice(row.price))}</div>
      ${chartBlock}
    </article>
  `;
  indexCardCache.set(row.id, { key: cacheKey, html });
  return html;
}

function indexBoard(): string {
  if (!indices.length && loadingIndices) {
    return `<div class="board-wrap"><div class="board-head"><h2 class="board-label">주요 지수</h2><span class="board-hint">불러오는 중</span></div><section class="board">${Array.from({ length: 8 }, () => `<article class="index sk"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w70"></div></article>`).join("")}</section></div>`;
  }
  if (!indices.length) return "";
  return `<div class="board-wrap"><div class="board-head"><h2 class="board-label">주요 지수</h2><span class="board-hint">${esc(indexBoardHint())}</span></div><section class="board">${indices.map(indexCard).join("")}</section></div>`;
}

function hasShell(): boolean {
  return Boolean(app.querySelector(".shell"));
}

function restoreScroll(mainTop: number, sideTop: number): void {
  const apply = (): void => {
    const nextMain = app.querySelector<HTMLElement>(".main");
    const nextSide = app.querySelector<HTMLElement>(".side");
    if (nextMain) nextMain.scrollTop = mainTop;
    if (nextSide) nextSide.scrollTop = sideTop;
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function updateStatusPills(): void {
  const st = marketStatus();
  const pills = app.querySelectorAll<HTMLElement>(".status-row .pill");
  if (pills[0]) pills[0].textContent = st.kr;
  if (pills[1]) pills[1].textContent = st.us;
}

function updateIndexBoard(): void {
  if (tab !== "market" && tab !== "mine") return;
  const sig = indicesSignature(indices);
  if (sig === boardSignature && app.querySelector(".board-wrap")) return;
  boardSignature = sig;
  const html = indexBoard();
  const existing = app.querySelector(".board-wrap");
  if (!html) {
    existing?.remove();
    return;
  }
  if (!existing) {
    paint();
    return;
  }
  const temp = document.createElement("div");
  temp.innerHTML = html;
  const next = temp.firstElementChild;
  if (next) existing.replaceWith(next);
}

function indexBoardHint(): string {
  const st = marketStatus();
  if (st.kr === "한국 개장" || st.us === "미국 개장") return "당일 장중 · 5분봉";
  return "금일 장 마감 · 5분봉";
}

function paintImmediate(): void {
  if (paintRaf) {
    cancelAnimationFrame(paintRaf);
    paintRaf = 0;
  }
  paintNow();
}

function paint(): void {
  if (batchingRefresh > 0) return;
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    paintNow();
  });
}

function paintNow(): void {
  const active = document.activeElement;
  const keepSearch = active?.id === "q" && active instanceof HTMLInputElement;
  const selStart = keepSearch ? active.selectionStart : null;
  const selEnd = keepSearch ? active.selectionEnd : null;
  const scrollMain = app.querySelector<HTMLElement>(".main");
  const scrollSide = app.querySelector<HTMLElement>(".side");
  const mainScrollTop = scrollMain?.scrollTop ?? 0;
  const sideScrollTop = scrollSide?.scrollTop ?? 0;
  const status = marketStatus();
  const loading = tab === "review" ? loadingReview : tab === "market" ? loadingMarket : loadingMine;
  const news = visibleNews();
  const { spotlight, rest } = splitFeed(news);
  const pop = popularStocks().filter((s) => !watchlist.some((w) => w.id === s.id)).slice(0, 10);

  app.innerHTML = `
    <div class="shell mobile-pane-${mobilePane}">
      <aside class="side">
        <button class="brand" data-home>
          <span class="logo">시황</span>
          <span class="tagline">시장을 움직이는 뉴스</span>
        </button>
        <div class="status-row">
          <span class="pill">${esc(status.kr)}</span>
          <span class="pill">${esc(status.us)}</span>
        </div>
        <label class="search-wrap">
          <span class="sr">종목 검색</span>
          <input id="q" type="search" placeholder="종목명, 티커, 종목코드" value="${esc(search)}" autocomplete="off" />
        </label>
        ${suggestions.length ? `
          <div class="suggest">
            ${suggestions.map((s) => `
              <button class="suggest-item" data-add="${esc(s.id)}" data-yahoo="${esc(s.yahoo)}" data-name="${esc(s.name)}" data-nameen="${esc(s.nameEn)}" data-market="${s.market}" data-price="${s.price ?? ""}" data-changepct="${s.changePct ?? ""}" data-currency="${s.currency ?? ""}">
                <strong>${esc(s.name)}</strong>
                <span>${esc(s.id)} · ${s.market === "kr" ? "한국" : "미국"}</span>
              </button>
            `).join("")}
          </div>
        ` : ""}
        <div class="side-head">
          <h2>관심종목</h2>
          <span>${watchlist.length}</span>
        </div>
        <div class="watchlist">
          ${watchlist.length ? watchlist.map(watchRow).join("") : `<div class="empty-side">위에서 종목을 검색해 추가하세요.</div>`}
        </div>
        ${pop.length ? `
          <div class="side-head"><h2>인기 종목</h2></div>
          <div class="chips">
            ${pop.map((s) => `<button class="chip" data-add="${esc(s.id)}" data-yahoo="${esc(s.yahoo)}" data-name="${esc(s.name)}" data-nameen="${esc(s.nameEn)}" data-market="${s.market}">${esc(s.name)}</button>`).join("")}
          </div>
        ` : ""}
      </aside>
      <main class="main">
        <header class="top">
          <div class="tabs">
            <button class="tab${tab === "market" ? " on" : ""}" data-tab="market">시장 속보</button>
            <button class="tab${tab === "mine" ? " on" : ""}" data-tab="mine">내 종목</button>
            <button class="tab${tab === "review" ? " on" : ""}" data-tab="review">흐름</button>
          </div>
          <div class="top-actions">
            <div class="seg">
              ${tab === "review" ? `
                <button class="seg-btn${reviewRange === "week" ? " on" : ""}" data-span="week">1주일</button>
                <button class="seg-btn${reviewRange === "month" ? " on" : ""}" data-span="month">1개월</button>
                <button class="seg-btn${reviewRange === "year" ? " on" : ""}" data-span="year">1년</button>
              ` : `
                <button class="seg-btn${regionFilter === "all" ? " on" : ""}" data-region="all">전체</button>
                <button class="seg-btn${regionFilter === "kr" ? " on" : ""}" data-region="kr">한국</button>
                <button class="seg-btn${regionFilter === "us" ? " on" : ""}" data-region="us">미국</button>
              `}
            </div>
            <button class="ghost" data-refresh>${loading ? "불러오는 중" : "새로고침"}</button>
          </div>
        </header>
        ${tab === "review" ? reviewPane() : `
        ${tab === "mine" ? `
          ${indexBoard()}
          <div class="filters">
            <button class="chip${filterId === "all" ? " on" : ""}" data-filter="all">전체</button>
            ${watchlist.map((s) => `<button class="chip${filterId === s.id ? " on" : ""}" data-filter="${esc(s.id)}">${esc(s.name)}</button>`).join("")}
          </div>
          ${filterId !== "all" ? stockDetailPanel() : ""}
        ` : `${indexBoard()}<p class="lead">금리 · 환율 · 실적 · 지정학처럼 증시에 바로 닿을 수 있는 소식만 모아 두었습니다.</p>
          ${sourcePullsHTML()}`}
        ${error ? `<div class="banner">${esc(error)}</div>` : ""}
        <section class="feed">
          ${loading && news.length === 0 ? skeleton() : ""}
          ${!loading && news.length === 0 ? emptyState() : ""}
          ${spotlight.length ? `<h2 class="feed-label">지금 주목</h2>${spotlight.map(newsCard).join("")}` : ""}
          ${rest.length ? `${spotlight.length ? `<h2 class="feed-label">최신</h2>` : ""}${rest.map(newsCard).join("")}` : ""}
        </section>
        `}
        <footer class="foot">
          ${lastFetch ? `뉴스 수집 ${esc(fromNow(lastFetch))}` : ""} · ${tab === "review" ? "1주일 · 1개월 · 1년 정리" : "하루치 보관 · 새 소식만 추가"}
        </footer>
      </main>
      <nav class="mob-nav" aria-label="화면 전환">
        <button type="button" class="mob-nav-btn${mobilePane === "news" ? " on" : ""}" data-pane="news">뉴스</button>
        <button type="button" class="mob-nav-btn${mobilePane === "watch" ? " on" : ""}" data-pane="watch">관심종목<span class="mob-nav-badge">${watchlist.length}</span></button>
      </nav>
    </div>
  `;

  if (keepSearch) {
    const input = app.querySelector<HTMLInputElement>("#q");
    input?.focus({ preventScroll: true });
    if (input && selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd);
  }

  restoreScroll(mainScrollTop, sideScrollTop);
}

function skeleton(): string {
  return Array.from({ length: 6 }, () => `<div class="card sk"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w70"></div></div>`).join("");
}

function emptyState(): string {
  if (tab === "mine" && watchlist.length === 0) {
    return `<div class="empty">관심종목을 추가하면 그 종목 뉴스만 모아 보여 줍니다.</div>`;
  }
  if (tab === "mine") {
    return `<div class="empty">이 종목과 연결된 최근 뉴스가 없습니다. 다른 종목을 고르거나 조금 뒤 다시 새로고침해 보세요.</div>`;
  }
  return `<div class="empty">시장 뉴스를 아직 못 받았습니다.<br>사이트는 약 10분마다 새 소식을 모읍니다. 잠시 뒤 새로고침해 보세요.</div>`;
}

function hitFromButton(btn: HTMLElement): SearchHit | undefined {
  const id = btn.dataset.add;
  const yahoo = btn.dataset.yahoo;
  const name = btn.dataset.name;
  const market = btn.dataset.market;
  if (!id || !yahoo || !name || (market !== "kr" && market !== "us")) return undefined;
  const price = Number(btn.dataset.price);
  const changePct = Number(btn.dataset.changepct);
  return {
    id,
    yahoo,
    name,
    nameEn: btn.dataset.nameen || name,
    market,
    price: Number.isFinite(price) ? price : undefined,
    changePct: Number.isFinite(changePct) ? changePct : undefined,
    currency: btn.dataset.currency || undefined,
  };
}

function bind(): void {
  app.addEventListener("click", (event) => {
    const t = event.target as HTMLElement;
    const home = t.closest<HTMLElement>("[data-home]");
    if (home) {
      tab = "market";
      clearStockFilter();
      showNewsPane();
      paint();
      return;
    }
    const paneBtn = t.closest<HTMLElement>("[data-pane]");
    if (paneBtn?.dataset.pane === "news" || paneBtn?.dataset.pane === "watch") {
      mobilePane = paneBtn.dataset.pane;
      paint();
      return;
    }
    const tabBtn = t.closest<HTMLElement>("[data-tab]");
    if (tabBtn?.dataset.tab === "market" || tabBtn?.dataset.tab === "mine" || tabBtn?.dataset.tab === "review") {
      tab = tabBtn.dataset.tab;
      if (tab === "market") {
        clearStockFilter();
        void refreshIndices();
      }
      showNewsPane();
      paint();
      return;
    }
    const spanBtn = t.closest<HTMLElement>("[data-span]");
    if (spanBtn?.dataset.span === "week" || spanBtn?.dataset.span === "month" || spanBtn?.dataset.span === "year") {
      reviewRange = spanBtn.dataset.span;
      tab = "review";
      showNewsPane();
      paint();
      return;
    }
    const regionBtn = t.closest<HTMLElement>("[data-region]");
    if (regionBtn?.dataset.region === "all" || regionBtn?.dataset.region === "kr" || regionBtn?.dataset.region === "us") {
      regionFilter = regionBtn.dataset.region;
      paint();
      return;
    }
    const refresh = t.closest<HTMLElement>("[data-refresh]");
    if (refresh) {
      void refreshAll();
      return;
    }
    const addBtn = t.closest<HTMLElement>("[data-add]");
    if (addBtn) {
      const hit = hitFromButton(addBtn);
      if (hit) addStock(hit);
      return;
    }
    const remove = t.closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove) {
      event.preventDefault();
      event.stopPropagation();
      removeStock(remove.dataset.remove);
      return;
    }
    const filter = t.closest<HTMLElement>("[data-filter]");
    if (filter?.dataset.filter) {
      if (filter.dataset.filter === "all") {
        clearStockFilter();
        tab = "mine";
      } else {
        selectStock(filter.dataset.filter);
        return;
      }
      showNewsPane();
      paint();
      return;
    }
    const open = t.closest<HTMLElement>("[data-open]");
    if (open?.dataset.open) {
      selectStock(open.dataset.open);
    }
  });

  app.addEventListener("input", (event) => {
    const t = event.target as HTMLElement;
    if (t.id === "q" && t instanceof HTMLInputElement) void onSearchInput(t.value);
  });

  app.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const t = event.target as HTMLElement;
    if (t.id !== "q") return;
    const first = suggestions[0] ?? typedStock(search);
    if (first) addStock(first);
  });
}

export function render(): void {
  bind();
  paintImmediate();
  void refreshAll();
  window.setInterval(() => {
    void refreshAll();
  }, 180_000);
  window.setInterval(() => {
    if (shouldPollIndices()) void refreshIndices({ live: true });
  }, INDEX_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (shouldPollIndices()) void refreshIndices({ live: true });
  });
  window.setInterval(updateStatusPills, 30_000);

  window.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const el = event.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
    event.preventDefault();
    app.querySelector<HTMLInputElement>("#q")?.focus({ preventScroll: true });
  });
}
